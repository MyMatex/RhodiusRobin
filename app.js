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
        return {
            genNumber: `${i + 1}0000`,
            number: line.id,
            description: line.title,
            quantity: line.quantity,
            price: line.price,
            discount: line.discount_allocations[0] ? line.discount_allocations[0] : '0.00'
        }
    })
}
const getSpecialItemsFromProducts = products => {
    return products.map(product => {
        if(product.price === 0) {
            return {
                genNumber: product.genNumber,
                number: product.number,
                id: 'FREEITEM',
                description: product.description
            }
        }
    })
}
const orderRequestAdapter = shopifyOrder => {
    const products = getProductsFromLines(shopifyOrder.line_items)
    const specialItems = getSpecialItemsFromProducts(products)
    return {
        config: {
            ip: process.env.FIEGE_SERVER_IP,
            port: process.env.FIEGE_SERVER_PORT,
            key: process.env.FIEGE_SERVER_KEY
        },
        order : {
            id: shopifyOrder.id,
            date: shopifyOrder.created_at.split('T')[0],
            time: shopifyOrder.created_at.split('T')[1]
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
                street: shopifyOrder.shipping_address.address1,
                number: 1,
                city: shopifyOrder.shipping_address.city,
                postalCode: shopifyOrder.shipping_address.zip
            }
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
        specialItems: specialItems[0] !== undefined ? specialItems : []
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
        await sleep(100)
        const xml = fs.readFileSync('request/createOrder.xml', 'utf-8');
        const adaptedData = orderRequestAdapter(order)
        const output = Mustache.render(xml, adaptedData);
        return soapRequest({ url: url, headers: sampleHeaders, xml: output, timeout: 100000 });
    })
}

app.get('/:status', async (req, res)=>{
    try {
        const { status } = req.params
        const orders = await axios.get(
            `https://${process.env.SHOPIFY_USER}:${process.env.SHOPIFY_KEY}@robin-schulz-x-my-mate.myshopify.com/admin/api/2023-01/orders.json?status=${status}`
            )
        const orderRequests = createOrderRequest(orders.data.orders)
        const ordersResponse = await Promise.allSettled(orderRequests)
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
  
app.listen(PORT, (error) =>{
    if(!error) {
        console.log("Server is Successfully Running, and App is listening on port "+ PORT)
    } else {
        console.log("Error occurred, server can't start", error);
    }
})