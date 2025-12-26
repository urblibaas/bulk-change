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

    // ------------------------------------------
    // A. PROCESS STARTING JOBS (Pending -> Active)
    // ------------------------------------------
    // Limit 20 to prevent 10s timeout
    const toStart = await Job.find({ 
      startTime: { $lte: now }, 
      status: 'pending' 
    }).limit(20);

    for (const job of toStart) {
      try {
        // 1. Get current price (so we can revert later)
        const getRes = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });
        
        if (!getRes.ok) throw new Error(`Fetch failed for ${job.variantId}`);
        const data = await getRes.json();
        
        const currentPrice = data.variant.price;

        // 2. Calculate Discount
        // (price * (1 - 10/100))
        const newPrice = (parseFloat(currentPrice) * (1 - job.discountPercent / 100)).toFixed(2);

        // 3. Update Shopify
        await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 
            'X-Shopify-Access-Token': SHOPIFY_TOKEN, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ variant: { id: job.variantId, price: newPrice } })
        });

        // 4. Update Database
        job.originalPrice = currentPrice;
        job.status = 'active';
        await job.save();
        
        log.started++;

      } catch (err) {
        console.error(`Start Job Error [${job.variantId}]:`, err.message);
        log.errors.push(err.message);
      }
    }

    // ------------------------------------------
    // B. PROCESS REVERTING JOBS (Active -> Completed)
    // ------------------------------------------
    const toRevert = await Job.find({ 
      endTime: { $lte: now }, 
      status: 'active' 
    }).limit(20);

    for (const job of toRevert) {
      try {
        if (!job.originalPrice) {
          throw new Error(`No original price found for ${job.variantId}`);
        }

        // 1. Revert Price
        await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 
            'X-Shopify-Access-Token': SHOPIFY_TOKEN, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ variant: { id: job.variantId, price: job.originalPrice } })
        });

        // 2. Mark Completed
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