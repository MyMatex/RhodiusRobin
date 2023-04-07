const express = require('express');
const fs = require('fs').promises;
const Mustache = require('mustache');
const soapRequest = require('easy-soap-request');
const axios = require('axios');
const qs = require('qs');
const { getGender } = require('gender-detection-from-name');
const { createMollieClient } = require('@mollie/api-client');
require('dotenv').config()
const xml2js = require('xml2js')
const app = express();
const PORT = 3000;
const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_KEY })
const Client = require('ssh2-sftp-client');
const sftp = new Client();
const parser = new xml2js.Parser();
const mongoose = require('mongoose');

const errorSchema = mongoose.Schema({error: Object});
const errorModel = mongoose.model('Error', errorSchema, 'errors');
const getProductsFromLines = lines => {
    let cursor = 1;
    const products = lines.map(line => {
        const [id, deposit] = line.sku.split('#');
        if(line.title !== 'Pfand') {
            if(deposit === 'DI') {
                const depositPrice = (12 * 0.25).toFixed(2)
                const price = (line.price - depositPrice).toFixed(2)
                const results = [
                    {
                    sku: line.sku,
                    genNumber: `${cursor}0000`,
                    number: id,
                    description: line.title,
                    quantity: line.quantity,
                    price,
                    discount: line?.discount_allocations[0]?.amount
                },
                {
                    sku: line.sku,
                    genNumber: `${cursor + 1}0000`,
                    number: 'DEPOSITITEM',
                    description: 'pfand',
                    quantity: line.quantity,
                    price: depositPrice
                }
            ]
                cursor+=2; 
                return results;
            } else {
                const result = {
                    sku: line.sku,
                    genNumber: `${cursor}0000`,
                    number: id,
                    description: line.title,
                    quantity: line.quantity,
                    price: line.price,
                } 
                cursor += 1;
                return result
            }
        }
    })
    return products.flat().filter(item => item)
}
const getSpecialItemsFromProducts = products => {
    return products.map(product => {
        if(parseFloat(product.price) === 0) {
            return {
                genNumber: product.genNumber,
                number: product.number,
                id: 'FREEITEM',
                description: product.description
            }
        }
    }).filter(item => item)
}
const getDepositItemsFromProducts = products => {
    const deposit = products.map((product, index) => {
        const [id, deposit] = product.sku.split('#')
        if(deposit === 'DI') {
            return {
                genNumber: parseInt(product.genNumber) + 10000,
                number: index + 1,
                id,
            }
        }
    })
    return deposit.filter((item,i) => deposit.findIndex((item2) => item?.id === item2?.id) === i).filter(depositItem => depositItem)
}
const getServiceCode = products => {
    const foundItem = products.find(product => {
        const serviceCode = product.sku.split('#')[2];
        return serviceCode === 'VERIFY';
    })
    return foundItem ? 'VERIFY' : 'STANDARD'
}
const getMethodCode = method => {
    if(method?.includes('Klarna')) {
        return 'KL_MO_MPAY'
    } else if(method?.includes('Credit')) {
        return 'CC_MO_MPAY'
    } else {
        return 'PP_MPAY'
    }
}

const getPSP = (methodCode, creditCompany) => {
    const cardDictionary = {
        'Mastercard': 'MC',
        'Visa': 'VI',
        undefined: 'MC'
    }
    if(methodCode === 'KL_MO_MPAY') {
        return 'KLARNA'
    } else if(methodCode === 'CC_MO_MPAY') {
        return cardDictionary[creditCompany]
    } else {
        return 'PAYPAL'
    }
}
const orderRequestAdapter = async (shopifyOrder, molliePayments) => {
    let payment;
    const products = getProductsFromLines(shopifyOrder.line_items)
    const specialItems = getSpecialItemsFromProducts(products)
    const depositItems = getDepositItemsFromProducts(products)
    const [PSP, method] = shopifyOrder?.gateway?.split('-')
    const methodCode = getMethodCode(method)
    if(methodCode === 'KL_MO_MPAY' || methodCode === 'CC_MO_MPAY') {
        payment = getMollie(molliePayments, shopifyOrder)
        await mollieClient.payments.update(payment.id, {description: `${shopifyOrder.id}`, metadata: { orderId: shopifyOrder.id }})
    } else {
        const paypalPayment = await paypalTransactions(new Date(shopifyOrder.created_at))
        payment = getPayPal(paypalPayment, shopifyOrder)
    }
    return {
        config: {
            ip: process.env.FIEGE_SERVER_IP,
            port: process.env.FIEGE_SERVER_PORT,
            key: process.env.FIEGE_SERVER_KEY
        },
        order : {
            id: shopifyOrder.id,
            date: shopifyOrder.created_at.split('T')[0],
            time: shopifyOrder.created_at.split('T')[1],
        },
        customer: {
            gender: getGender(shopifyOrder.customer.firstName)[0].toUpperCase(),
            number: shopifyOrder.customer.id,
            name: `${shopifyOrder.customer.first_name} ${shopifyOrder.customer.last_name}`,
            firstName: shopifyOrder.customer.first_name,
            lastName: shopifyOrder.customer.last_name,
            email: shopifyOrder.customer.email
        },
        shiping: {
            address: {
                street: shopifyOrder.shipping_address?.address1,
                number: 1,
                city: shopifyOrder.shipping_address?.city,
                postalCode: shopifyOrder.shipping_address?.zip
            },
            serviceCode: getServiceCode(shopifyOrder.line_items)
        },
        payment: {
            amount: shopifyOrder.current_total_price,
            shipingAmount: shopifyOrder.total_shipping_price_set.shop_money.amount,
            isShipingFree: shopifyOrder.total_shipping_price_set.shop_money.amount === 0,
            methodCode,
            PSP: getPSP(methodCode, shopifyOrder?.payment_details?.credit_card_company),
            id: payment.id,
            transactionId: payment.description,
            currency: shopifyOrder.currency 
        },
        products,
        specialItems: specialItems.length > 0 ? specialItems : [],
        depositItems: depositItems.length > 0 ? depositItems : []
    }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createOrderRequest = (orders, molliePayments, paypalPayments) => {
    const url = process.env.FIEGE_ENDPOINT;
    const sampleHeaders = {
    'user-agent': 'sampleTest',
    'Content-Type': 'text/xml;charset=UTF-8',
    };
    return orders.map(async order => {
        await sleep(1000)
        const xml = await fs.readFile('request/createOrder.xml', 'utf-8');
        const adaptedData = await orderRequestAdapter(order, molliePayments, paypalPayments)
        const output = Mustache.render(xml, adaptedData);
        return soapRequest({ url: url, headers: sampleHeaders, xml: output, timeout: 200000 });
    })
}

const findProductBySku = (products, sku) => products.find(product => product.variants[0].sku.split('#')[0] === sku)

const getMollie = (molliePayments, order) => {
    let id = '';
    let description = '';
    const cat = new Date(order.created_at).getTime();
    for(let i = 0; i < molliePayments.length; i++) {
        const molliePaymentTime = new Date(molliePayments[i].paidAt).getTime();
        const difference = cat - molliePaymentTime;
        if(difference > 0 && difference < 8000 && molliePayments[i].amount.value === order.current_total_price) {
            id = molliePayments[i].id
            if(molliePayments[i].orderId) {
                description = molliePayments[i].orderId
            } else {
                description = molliePayments[i].description
            }
        }
    }
    return {id, description};
}

const paypalTransactions = async (orderDate) => {
    const data = qs.stringify({
        'grant_type': 'client_credentials',
        'ignoreCache': 'true',
        'return_authn_schemes': 'true',
        'return_client_metadata': 'true',
        'return_unconsented_scopes': 'true' 
      });
      
      const config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://api-m.paypal.com/v1/oauth2/token',
        headers: { 
          'Authorization': `Basic ${process.env.PAYPAL_AUTH}`, 
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        data : data
      };
      
      const token = await axios.request(config)
      const orderDateMinusTen = new Date(orderDate)
      orderDateMinusTen.setSeconds(orderDate.getSeconds() - 10)
        let configTransaction = {
            method: 'get',
            maxBodyLength: Infinity,
            url: `https://api-m.paypal.com/v1/reporting/transactions?fields=transaction_info,payer_info,shipping_info,auction_info,cart_info,incentive_info,store_info&start_date=${orderDateMinusTen.toISOString()}&end_date=${orderDate.toISOString()}`,
            headers: { 
              'Authorization': `Bearer ${token.data.access_token}`, 
              'Cookie': 'l7_az=ccg14.slc'
            }
          };
        const transactions = await axios.request(configTransaction)
        return transactions.data
}

const getPayPal = (paypalPayments, order) => {
    let id = '';
    let description = '';
    for(let i = 0; i < paypalPayments.transaction_details.length; i++) {
        const paypalPrice = paypalPayments.transaction_details[0].transaction_info.transaction_amount.value
        if(paypalPrice === order.current_total_price) {
            id = paypalPayments.transaction_details[i].transaction_info.transaction_id
            description = paypalPayments.transaction_details[i].transaction_info.paypal_account_id
        }
    }
    return {id, description};
}

const formatErrors = errors => errors.map(error => ({ error }))

app.get('/errors/retry', async(req, res) => {
    try {
        const errorsPromise = errorModel.find({}).sort({_id: -1}).limit(10);
        const molliePaymentsPromise = mollieClient.payments.page({ limit: 15 });
        const [errors, molliePayments] = await Promise.all([errorsPromise, molliePaymentsPromise])
        const orders = errors.map(({error}) => error)
        const orderRequests = createOrderRequest(orders, molliePayments)
        ordersResponse = await Promise.allSettled(orderRequests)
        res.send(ordersResponse)
    } catch(e) {
        console.log(e)
        res.send(e)
    }
})

app.post('/:status', async (req, res)=>{
    let ordersResponse;
    try {
        const { status } = req.params
        const ordersPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const molliePaymentsPromise = mollieClient.payments.page({ limit: 15 });
        const [orders, molliePayments] = await Promise.all([ordersPromise, molliePaymentsPromise])
        const orderRequests = createOrderRequest(orders.data.orders.slice(0,9), molliePayments)
        ordersResponse = await Promise.allSettled(orderRequests)
        console.log(JSON.stringify(ordersResponse))
        const failedOrders = ordersResponse.map((orderResp, i) => {
            const isOrderFailed = orderResp?.value?.response?.body.includes('500')
            const isOrderOutOfTheSystem = !orderResp?.value?.response?.body.includes('existiert bereits')
            const isOrderRejected = orderResp.status === 'rejected'
            if((isOrderFailed && isOrderOutOfTheSystem) || isOrderRejected) return orders.data.orders[i]
        }).filter(order => order)
        const errors = formatErrors(failedOrders)
        await errorModel.insertMany(errors,  { ordered: false, rawResult: true })
        res.send(ordersResponse);
    } catch(e) {
        console.log(e)
        res.send(ordersResponse);
    }

});
app.get('/connect', async(req, res) => {
    try {
        await sftp.connect({
            host: process.env.FTP_HOST,
            port: process.env.FTP_PORT,
            username: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD
          })
          res.send({status: 'ok'})
    } catch(e) {
        res.send(e)
    }
})
app.get('/dictionary/:status', async(req, res) => {
    const { status } = req.params
    const orders = await axios.get(
        `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
        )
    const dictionary = orders.data.orders.map(order => `<p>The orderId for ticket ${order.name} is ${order.id}</p>`)
    res.set('Content-Type', 'text/html');
    res.send(Buffer.from(dictionary.toString()));
})
app.get('/test/:status/:number', async (req, res)=>{
    try {
        const url = process.env.FIEGE_ENDPOINT;
        const sampleHeaders = {
            'user-agent': 'sampleTest',
            'Content-Type': 'text/xml;charset=UTF-8',
            };
        const { status, number } = req.params
        const ordersPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const xmlPromise = fs.readFile('request/createOrder.xml', 'utf-8');
        const molliePaymentsPromise = mollieClient.payments.page({ limit: 15 });
        const [orders, xml, molliePayments] = await Promise.all([ordersPromise, xmlPromise, molliePaymentsPromise]) 
        const adaptedData = await orderRequestAdapter(orders.data.orders[number], molliePayments)
        const output = Mustache.render(xml, adaptedData);
        //const response = await soapRequest({ url, headers: sampleHeaders, xml: output, timeout: 200000 });
        res.send(output);
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }
});

app.post('/status/update', async(req, res) => {
    try {
        await sftp.connect({
            host: process.env.FTP_HOST,
            port: process.env.FTP_PORT,
            username: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD
          })
        const responses = []
        const list = await sftp.list('/OUT');
        const dict = {
            'COMP': 'close.json',
            'CNCL': 'cancel.json',
            'CNFD': 'open.json'
        }
        for(let i = 0; i < list.length; i++) {
            if(!list[i].name.includes('FULL_STOCK') && !list[i].name.includes('E')) {
                const remoteFilePath = '/OUT/' + list[i].name;
                const stream = await sftp.get(remoteFilePath)
                const result = await parser.parseStringPromise(stream)
                const orderId = result.OrderReplies.OrderReply[0].Header[0].OrderNo[0];
                const status = result.OrderReplies.OrderReply[0].Header[0].OrderStatus[0];
                if(!orderId.includes('RHODIUS')) {
                    const configTransaction = {
                        method: 'post',
                        maxBodyLength: Infinity,
                        url: `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-04/orders/${orderId}/${dict[status]}`,
                    };
                    const request = axios.request(configTransaction)
                    responses.push(request)
                }
            }
        }
        await Promise.allSettled(responses)
        res.send({status: 'ok'})
    } catch(e) {
        console.log(e)
        res.send({error: 'aspojfios'})
    }
})

app.post('/inventory/update', async (req, res)=>{
    try {
       await sftp.connect({
            host: process.env.FTP_HOST,
            port: process.env.FTP_PORT,
            username: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD
          })
        const list = await sftp.list('/OUT');
        const remoteFilePath = '/OUT/' + list[0].name;
        const stream = await sftp.get(remoteFilePath)
        const productsPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2022-10/products.json`
            )
        const locationsPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/locations.json`
            )
        const [products, locations] = await Promise.all([productsPromise, locationsPromise])
        const inventoryCalls =[]
        const result = await parser.parseStringPromise(stream)
        for(let i = 0; i < result.ExItemAvailQtyList.Item.length; i++) {
            const product = findProductBySku(products.data.products, result.ExItemAvailQtyList.Item[i].ItemNo[0])
            const location = locations.data.locations[0]
            const payload = {
                "location_id":location.id,
                "inventory_item_id":product?.variants[0]?.inventory_item_id,
                "available":result.ExItemAvailQtyList.Item[i].AvailableQuantity[0]
            };
            const responsePromise = axios.post(
                `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/inventory_levels/set.json`, 
                payload
                );
            inventoryCalls.push(responsePromise)
        }
        await Promise.allSettled(inventoryCalls)
        res.send({status: 'ok'})
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }

});
  
app.listen(PORT, (error) =>{
    if(!error) {
        console.log("Server is Successfully Running, and App is listening on port "+ PORT)
        mongoose.connect(process.env.MONGO_URI).then(() => console.log('Connected!'));
    } else {
        console.log("Error occurred, server can't start", error);
    }
})
