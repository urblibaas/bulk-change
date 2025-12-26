const express = require('express');
const cors = require('cors');
const app = express();

// 1. HARDCODED CREDENTIALS (The "Villain" Way)
// Ideally, put these in Vercel Environment Variables, but you can hardcode them if you want.
const SHOP = process.env.SHOP; // Change this
const TOKEN = process.env.TOKEN || "shpat_xxxxxxxxxxxxxxxxxxxx"; 

// 2. FIX CORS (Allow the merchant's store to talk to this server)
app.use(cors({
    origin: [`https://${SHOP}`, `https://${SHOP}/admin`, `https://${SHOP}/editor`],
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

app.post('/api/bulk-change', async (req, res) => {
    const { variantIds, discount } = req.body;

    // Security Check: Basic check to ensure we have data
    if (!variantIds || !variantIds.length) {
        return res.status(400).json({ error: "No variants provided" });
    }

    console.log(`Processing ${variantIds.length} variants...`);

    try {
        // 3. PARALLEL EXECUTION (Crucial for Vercel)
        // Vercel times out in 10s. We fire all requests at once using Promise.all
        const updates = variantIds.map(async (id) => {
            try {
                // A. Get current price
                const getRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                    headers: { 'X-Shopify-Access-Token': TOKEN }
                });
                
                if (!getRes.ok) return { id, status: 'failed_fetch' };
                const data = await getRes.json();
                
                const currentPrice = parseFloat(data.variant.price);
                const newPrice = (currentPrice * (1 - discount / 100)).toFixed(2);

                // B. Update price
                const updateRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                    method: 'PUT',
                    headers: {
                        'X-Shopify-Access-Token': TOKEN,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        variant: { id: id, price: newPrice }
                    })
                });

                return { id, status: updateRes.ok ? 'success' : 'failed_update' };
            } catch (err) {
                return { id, status: 'error' };
            }
        });

        // Wait for all to finish
        const results = await Promise.all(updates);
        
        res.json({ success: true, results });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Vercel Serverless Export
module.exports = app;