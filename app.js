const express = require('express');
const fs = require('fs');
const Mustache = require('mustache');
const soapRequest = require('easy-soap-request');
const axios = require('axios');
const { getGender } = require('gender-detection-from-name');
const { createMollieClient } = require('@mollie/api-client');
require('dotenv').config()
const app = express();
const PORT = 3000;
const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_KEY })
const getProductsFromLines = lines => {
    let cursor = 1;
    const products = lines.map(line => {
        const [id, deposit] = line.sku.split('#');
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
                discount: line.total_discount
            },
            {
                sku: line.sku,
                genNumber: `${cursor + 1}0000`,
                number: 'DEPOSITITEM',
                description: 'pfand',
                quantity: line.quantity,
                price: depositPrice,
                discount: line.total_discount
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
                discount: line.total_discount
            } 
            cursor += 1;
            return result
        }

    })
    return products.flat()
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
const orderRequestAdapter = (shopifyOrder, molliePayments) => {
    const products = getProductsFromLines(shopifyOrder.line_items)
    const specialItems = getSpecialItemsFromProducts(products)
    const depositItems = getDepositItemsFromProducts(products)
    const [PSP, method] = shopifyOrder?.gateway?.split('-')
    const methodCode = method?.includes('Klarna') ? 'KL_MO_MPAY' : 'CC_MO_MPAY';
    const mollie = getMollie(molliePayments, shopifyOrder)
    const cardDictionary = {
        'Mastercard': 'MC',
        'Visa': 'VI',
        undefined: 'MC'
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
            PSP: methodCode === 'KL_MO_MPAY' ? 'KLARNA' : cardDictionary[shopifyOrder?.payment_details?.credit_card_company],
            id: mollie.id,
            transactionId: mollie.description,
            currency: shopifyOrder.currency 
        },
        products,
        specialItems: specialItems.length > 0 ? specialItems : [],
        depositItems: depositItems.length > 0 ? depositItems : []
    }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createOrderRequest = (orders, molliePayments) => {
    const url = process.env.FIEGE_ENDPOINT;
    const sampleHeaders = {
    'user-agent': 'sampleTest',
    'Content-Type': 'text/xml;charset=UTF-8',
    };
    return orders.map(async order => {
        await sleep(1000)
        const xml = fs.readFileSync('request/createOrder.xml', 'utf-8');
        const adaptedData = orderRequestAdapter(order, molliePayments)
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
            description = molliePayments[i].description
        }
    }
    return {id, description};
}

app.post('/:status', async (req, res)=>{
    try {
        const { status } = req.params
        const ordersPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const molliePaymentsPromise = mollieClient.payments.page({ limit: 15 });
        const [orders, molliePayments] = await Promise.all([ordersPromise, molliePaymentsPromise])
        const orderRequests = createOrderRequest(orders.data.orders, molliePayments)
        const ordersResponse = await Promise.allSettled(orderRequests)
        console.log(JSON.stringify(ordersResponse))
        res.send(ordersResponse);
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }

});
app.get('/test/:status/:number', async (req, res)=>{
    try {
        const { status, number } = req.params
        const orders = await axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const xml = fs.readFileSync('request/createOrder.xml', 'utf-8');
        const molliePayments = await mollieClient.payments.page({ limit: 15 });
        const adaptedData = orderRequestAdapter(orders.data.orders[number], molliePayments)

        const output = Mustache.render(xml, adaptedData);
        res.send(output);
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }
});

app.put('/test/update/:sku/:quantity', async (req, res)=>{
    try {
        const productsPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2022-10/products.json`
            )
        const locationsPromise = axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/locations.json`
            )
        const [products, locations] = await Promise.all([productsPromise, locationsPromise])
        const product = findProductBySku(products.data.products, req.params.sku)
        const location = locations.data.locations[0]
        const payload = {
            "location_id":location.id,
            "inventory_item_id":product.variants[0].inventory_item_id,
            "available":req.params.quantity
        };
        const inventory = await axios.post(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/inventory_levels/set.json`, 
            payload
            );
        res.send(inventory.data);
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }

});
  
app.listen(PORT, (error) =>{
    if(!error) {
        console.log("Server is Successfully Running, and App is listening on port "+ PORT)
    } else {
        console.log("Error occurred, server can't start", error);
    }
})