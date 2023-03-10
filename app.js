const express = require('express');
const fs = require('fs');
const Mustache = require('mustache');
const soapRequest = require('easy-soap-request');
const axios = require('axios');
const { getGender } = require('gender-detection-from-name');
require('dotenv').config()
const app = express();
const PORT = 3000;

const getProductsFromLines = lines => {
    return lines.map((line, i) => {
        const [id, deposit] = line.sku.split('#');
        return {
            sku: line.sku,
            genNumber: `${i + 1}0000`,
            number: id,
            description: line.title,
            quantity: line.quantity,
            price: line.price,
            discount: line.total_discount
        }
    })
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
    return products.map((product, index) => {
        const [id, deposit] = product.sku.split('#')
        if(deposit === 'DI') {
            return {
                genNumber: product.genNumber,
                number: index,
                id,
            }
        }
    }).filter(item => item)
}
const getServiceCode = products => {
    const foundItem = products.find(product => {
        const serviceCode = product.sku.split('#')[2];
        return serviceCode === 'VERIFY';
    })
    return foundItem ? 'VERIFY' : 'STANDARD'
}
const orderRequestAdapter = shopifyOrder => {
    const products = getProductsFromLines(shopifyOrder.line_items)
    const specialItems = getSpecialItemsFromProducts(products)
    const depositItems = getDepositItemsFromProducts(products)
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
            methodCode: 'PP_MPAY',
            PSP: 'PAYPAL',
            id: shopifyOrder.checkout_id,
            transactionId: shopifyOrder.checkout_token,
            currency: shopifyOrder.currency 
        },
        products,
        specialItems: specialItems.length > 0 ? specialItems : [],
        depositItems: depositItems.length > 0 ? depositItems : []
    }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createOrderRequest = orders => {
    const url = process.env.FIEGE_ENDPOINT;
    const sampleHeaders = {
    'user-agent': 'sampleTest',
    'Content-Type': 'text/xml;charset=UTF-8',
    };
    return orders.map(async order => {
        await sleep(1000)
        const xml = fs.readFileSync('request/createOrder.xml', 'utf-8');
        const adaptedData = orderRequestAdapter(order)
        const output = Mustache.render(xml, adaptedData);
        return soapRequest({ url: url, headers: sampleHeaders, xml: output, timeout: 200000 });
    })
}

const findProductBySku = (products, sku) => products.find(product => product.variants[0].sku.split('#')[0] === sku)

app.post('/:status', async (req, res)=>{
    try {
        const { status } = req.params
        const orders = await axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const orderRequests = createOrderRequest(orders.data.orders)
        const ordersResponse = await Promise.allSettled(orderRequests)
        console.log(orderRequests)
        res.send(ordersResponse);
    } catch(e) {
        console.log(e)
        res.status(500).send(e.message)
    }

});
app.get('/test/:status', async (req, res)=>{
    try {
        const { status } = req.params
        const orders = await axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const xml = fs.readFileSync('request/createOrder.xml', 'utf-8');
        const adaptedData = orderRequestAdapter(orders.data.orders[0])
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