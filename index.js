const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// ---------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------
// Ideally, set these in Vercel Environment Variables.
// If you are lazy, you can hardcode strings here (but be careful!).
const SHOP_DOMAIN = process.env.SHOP || "your-store.myshopify.com"; 
const SHOPIFY_TOKEN = process.env.TOKEN; // shpat_...
const MONGO_URI = process.env.MONGODB_URI; 
const CRON_SECRET = process.env.CRON_SECRET || "my_super_secret_password";

app.use(express.json());
// Allow CORS so your Shopify Theme Editor can talk to this server
app.use(cors({ origin: '*' }));

// ---------------------------------------------
// 2. MONGODB CONNECTION (Serverless Optimized)
// ---------------------------------------------
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false, // Vital for Vercel: fail fast if no connection
    };

    cached.promise = mongoose.connect(MONGO_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

// ---------------------------------------------
// 3. DATABASE SCHEMA
// ---------------------------------------------
const JobSchema = new mongoose.Schema({
  variantId: String,
  originalPrice: String, // Stored as string to prevent float math errors
  discountPercent: Number,
  originalCompareAt: String,
  startTime: Date,
  endTime: Date,
  status: { 
    type: String, 
    enum: ['pending', 'active', 'completed'], 
    default: 'pending' 
  }
});

// Check if model exists before compiling to prevent OverwriteModelError in serverless hot-reloads
const Job = mongoose.models.Job || mongoose.model('Job', JobSchema);

// ---------------------------------------------
// 4. API ROUTES
// ---------------------------------------------

// Root check
app.get('/', (req, res) => res.send('Price Scheduler API is running!'));

/**
 * POST /api/schedule
 * Call this from your Liquid Section to save jobs to DB.
 */
app.post('/api/schedule', async (req, res) => {
  try {
    await connectToDatabase(); // Wait for DB

    const { variantIds, discount, startAt, endAt } = req.body;

    if (!variantIds || !variantIds.length) {
      return res.status(400).json({ error: "No variant IDs provided." });
    }

    // Prepare jobs array
    const jobs = variantIds.map(id => ({
      variantId: id,
      discountPercent: discount,
      startTime: new Date(startAt),
      endTime: new Date(endAt),
      status: 'pending'
    }));

    // Save to DB
    await Job.insertMany(jobs);

    res.json({ success: true, message: `Successfully scheduled ${jobs.length} items.` });
    
  } catch (error) {
    console.error("Schedule Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cron
 * Call this from cron-job.org every minute.
 * Example: https://your-app.vercel.app/api/cron?key=my_super_secret_password
 */
app.get('/api/cron', async (req, res) => {
  // 1. Security Check
  if (req.query.key !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = new Date();
  const log = { started: 0, reverted: 0, errors: [] };

  try {
    await connectToDatabase();

    // ==========================================
    // A. START JOBS (Apply Additive Discount)
    // ==========================================
    const toStart = await Job.find({ 
      startTime: { $lte: now }, 
      status: 'pending' 
    }).limit(20);

    for (const job of toStart) {
      try {
        // 1. Fetch current data
        const getRes = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });
        const data = await getRes.json();
        
        // Parse numbers safely
        const currentPrice = parseFloat(data.variant.price);
        const rawCompare = data.variant.compare_at_price;
        const currentCompare = rawCompare ? parseFloat(rawCompare) : 0;

        // 2. Determine "Anchor" Price (The true Base Price)
        // If CompareAt exists and is higher than price, use it. Otherwise use Price.
        const anchorPrice = (currentCompare > currentPrice) ? currentCompare : currentPrice;

        // 3. Calculate Existing Discount Percentage
        // Example: Anchor 100, Price 80 = 20% existing gap.
        let existingDiffPercent = 0;
        if (anchorPrice > 0 && currentPrice < anchorPrice) {
            existingDiffPercent = ((anchorPrice - currentPrice) / anchorPrice) * 100;
        }

        // 4. Add Merchant's Discount
        // Example: Existing 20% + Merchant 10% = 30% Total
        const totalDiscountPercent = existingDiffPercent + job.discountPercent;

        // 5. Calculate New Price based on Anchor
        // Example: 100 * (1 - 0.30) = 70
        let newPrice = (anchorPrice * (1 - totalDiscountPercent / 100)).toFixed(2);
        
        // Safety check: Price cannot be negative
        if (newPrice < 0) newPrice = "0.00";

        // 6. Update Shopify
        // We MUST set compare_at_price to the anchor so the discount badge shows correctly
        await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 
            'X-Shopify-Access-Token': SHOPIFY_TOKEN, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ 
            variant: { 
              id: job.variantId, 
              price: newPrice,
              compare_at_price: anchorPrice.toFixed(2) // Lock in the Anchor
            } 
          })
        });

        // 7. Save state to DB (So we can revert later)
        job.originalPrice = currentPrice.toFixed(2);
        job.originalCompareAt = rawCompare; // Keep null if it was null
        job.status = 'active';
        await job.save();
        
        log.started++;

      } catch (err) {
        console.error(`Start Job Error [${job.variantId}]:`, err.message);
        log.errors.push(err.message);
      }
    }

    // ==========================================
    // B. REVERT JOBS (Restore Original)
    // ==========================================
    const toRevert = await Job.find({ 
      endTime: { $lte: now }, 
      status: 'active' 
    }).limit(20);

    for (const job of toRevert) {
      try {
        // We need to restore both Price AND Compare At Price
        // If originalCompareAt was null, sending null removes it from Shopify
        await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 
            'X-Shopify-Access-Token': SHOPIFY_TOKEN, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ 
            variant: { 
              id: job.variantId, 
              price: job.originalPrice,
              compare_at_price: job.originalCompareAt 
            } 
          })
        });

        job.status = 'completed';
        await job.save();

        log.reverted++;

      } catch (err) {
        console.error(`Revert Job Error [${job.variantId}]:`, err.message);
        log.errors.push(err.message);
      }
    }

    res.json({ success: true, log });

  } catch (error) {
    console.error("Cron Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Required for Vercel
module.exports = app;