const express = require('express');
const fetch = require('node-fetch');
const app = express();
const cors = require('cors');
app.use(express.json());
app.use(cors());
const SHOP = process.env.SHOP;
const TOKEN = process.env.TOKEN; // Use a real Admin Token

app.post('/bulk-change', async (req, res) => {
    const { discount, variantIds, dryRun } = req.body;
    console.log(`Cooking ${variantIds.length} variants at ${discount}% discount. DryRun: ${dryRun}`);

    if (dryRun) {
        return res.json({ success: true, count: variantIds.length, message: "Dry run complete. No prices changed." });
    }

    try {
        // Map variants to update promises
        const updates = variantIds.map(async (id) => {
            // 1. Get current price
            const getRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                headers: { 'X-Shopify-Access-Token': TOKEN }
            });
            const data = await getRes.json();
            
            if (!data.variant) return null;

            const currentPrice = parseFloat(data.variant.price);
            const newPrice = (currentPrice * (1 - discount / 100)).toFixed(2);

            // 2. Update price
            return fetch(`https://${SHOP}/admin/api/2024-01/variants/${id}.json`, {
                method: 'PUT',
                headers: {
                    'X-Shopify-Access-Token': TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    variant: {
                        id: id,
                        price: newPrice,
                        compare_at_price: currentPrice // Move old price to compare-at
                    }
                })
            });
        });

        await Promise.allSettled(updates);
        res.json({ success: true, count: variantIds.length });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(3000, () => console.log('Villainous API running on port 3000'));