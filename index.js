const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// USE ENVIRONMENT VARIABLES IN VERCEL SETTINGS!
const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;

app.post('/api/bulk-change', async (req, res) => {
    const { discount, variantIds, dryRun } = req.body;

    if (dryRun) return res.json({ success: true, message: "Dry run" });

    try {
        // IMPORTANT: Serverless functions are fast. 
        // We use Promise.all to fire requests in parallel to beat the 10s timeout.
        const results = await Promise.all(variantIds.map(async (id) => {
            try {
                // 1. Get current price
                const getRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                    headers: { 'X-Shopify-Access-Token': TOKEN }
                });
                const data = await getRes.json();
                
                if (!data.variant) return { id, status: 'failed' };

                const currentPrice = parseFloat(data.variant.price);
                const newPrice = (currentPrice * (1 - discount / 100)).toFixed(2);

                // 2. Update price
                await fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                    method: 'PUT',
                    headers: {
                        'X-Shopify-Access-Token': TOKEN,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        variant: { id, price: newPrice, compare_at_price: currentPrice }
                    })
                });
                return { id, status: 'success' };
            } catch (err) {
                return { id, status: 'error', error: err.message };
            }
        }));

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// VERCEL REQUIREMENT: Export the app
module.exports = app;