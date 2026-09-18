import dotenv from "dotenv";
dotenv.config(); // load env variables first

import express from "express";
import { registrationRouter, setupRegistration, startRegistrationCleanup, deleteRegistrationData } from "./registration.js";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from 'node-fetch';
import crypto from 'crypto';
import { startTelegramBot } from "./services/telegramwiper.js";

// Fix for @simplewebauthn in Node.js - set global crypto
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

// WebAuthn imports
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

console.log("🔧 [INIT] Loading server modules...");
console.log("🔐 [WEBAUTHN] WebAuthn module loaded");
console.log("🔐 [WEBAUTHN] Crypto API available:", !!globalThis.crypto);

// --- Environment Variables (loaded from Railway) ---
const ADMIN_PASS = process.env.ADMIN_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- CORS Allowed Origins ---
const ALLOWED_ORIGINS = [
  'https://socialclubamsterdam.com',
  'https://www.socialclubamsterdam.com',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
console.log("🌐 [CORS] Allowed origins:", ALLOWED_ORIGINS);

// --- WebAuthn Configuration ---
// Detect if we're on Railway (production) or local development
const isProduction = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production' || process.env.MONGO_URI?.includes('mongodb+srv');

const WEBAUTHN_CONFIG = {
  rpName: 'Social Club Amsterdam',
  rpID: isProduction ? 'www.socialclubamsterdam.com' : 'localhost',
  origin: isProduction 
    ? ['https://www.socialclubamsterdam.com', 'https://socialclubamsterdam.com']
    : ['http://localhost:5500', 'http://127.0.0.1:5500'],
  maxPasskeys: 10, // Maximum number of passkeys allowed
};
console.log("🔐 [WEBAUTHN] Config:", { 
  isProduction, 
  rpID: WEBAUTHN_CONFIG.rpID, 
  origins: WEBAUTHN_CONFIG.origin,
  maxPasskeys: WEBAUTHN_CONFIG.maxPasskeys 
});

// Temporary challenge store (in-memory) - challenges expire after 5 minutes
const challengeStore = new Map();
function storeChallenge(id, challenge) {
  challengeStore.set(id, { challenge, timestamp: Date.now() });
  // Clean up after 5 minutes
  setTimeout(() => challengeStore.delete(id), 5 * 60 * 1000);
}
function getChallenge(id) {
  const data = challengeStore.get(id);
  if (data) {
    challengeStore.delete(id); // One-time use
    return data.challenge;
  }
  return null;
}

// --- Telegram Notification Helper ---
export async function sendTelegramNotification(text) {
  try {
    // Send message
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.description);

    const messageId = data.result.message_id;

    // Schedule self-destruct (48 hours)
    setTimeout(async () => {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
          }),
        });
        console.log(`💥 Auto-deleted Telegram message ${messageId}`);
      } catch (err) {
        console.error(`❌ Failed to delete Telegram message ${messageId}:`, err.message);
      }
    }, 48 * 60 * 60 * 1000); // 48h


    return true;
  } catch (err) {
    console.error("Error sending Telegram notification:", err);
    return false;
  }
}


const app = express();

// Trust proxy (required for Railway to get correct client IP)
// Railway uses a single proxy, so we trust only the first hop
app.set('trust proxy', 1);

// =============================================================================
// 🛡️ SECURITY & PERFORMANCE MIDDLEWARE
// =============================================================================

// 1️⃣ Security Headers (helmet.js)
console.log("🛡️ [SECURITY] Applying Helmet security headers...");
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false // Disable CSP for API
}));
console.log("✅ [SECURITY] Helmet configured");

// 2️⃣ CORS - Restrict to allowed origins
console.log("🌐 [CORS] Configuring CORS restrictions...");
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ [CORS] Blocked request from unauthorized origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
console.log("✅ [CORS] CORS configured");

// 3️⃣ Compression - gzip responses for faster transfers
console.log("⚡ [PERF] Enabling gzip compression...");
app.use(compression());
console.log("✅ [PERF] Compression enabled");

// 4️⃣ JSON body parser
app.use(express.json());

// 5️⃣ Rate Limiting - Prevent abuse
console.log("🚦 [SECURITY] Configuring rate limiters...");

// General API limiter: 600 requests per 15 minutes for the shared staff Wi-Fi.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    console.warn(`🚫 [RATE] General limit exceeded for IP: ${req.ip}`);
    res.status(429).json(options.message);
  }
});

// Auth limiter: 10 attempts per 15 minutes (stricter for login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    console.warn(`🚫 [RATE] Auth limit exceeded for IP: ${req.ip}`);
    res.status(429).json(options.message);
  }
});

// Prefill/upload limiter: allows groups sharing the club Wi-Fi.
const prefillLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many submissions, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    console.warn(`🚫 [RATE] Prefill limit exceeded for IP: ${req.ip}`);
    res.status(429).json(options.message);
  }
});

// Apply general rate limit to all API routes
app.use('/api', generalLimiter);
console.log("✅ [SECURITY] Rate limiters configured");

console.log("=".repeat(60));
console.log("🛡️ ALL SECURITY MIDDLEWARE LOADED SUCCESSFULLY");
console.log("=".repeat(60));

// 🌿 MongoDB Setup
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  ssl: true,
});

let db;
async function connectDB() {
  try {
    await client.connect();
    const connectedDB = client.db("Amsterdam0");
    await setupRegistration(connectedDB);
    db = connectedDB;
    console.log("✅ Connected to MongoDB!");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}
connectDB();

// --- Start Telegram Bot ---
startTelegramBot(); // 🟢 Launch bot on server start with test startup message

// --- ROUTES ---

app.get("/", (req, res) => {
  res.send("Server is live! 🌿");
});

// 💚 Health Check Endpoint (for uptime monitoring services)
app.get("/health", (req, res) => {
  const healthcheck = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    mongodb: db ? "connected" : "disconnected",
    version: "1.1.0"
  };
  console.log(`💚 [HEALTH] Health check requested - MongoDB: ${healthcheck.mongodb}`);
  res.status(200).json(healthcheck);
});

// 🔐 Admin login – supports env-var master admin AND DB-based admins
app.post("/api/admin-login", authLimiter, async (req, res) => {
  const { password, email } = req.body;
  // 1) Env-var master admin (no email required)
  if (password === process.env.ADMIN_PASS && (!email || email === 'admin')) {
    const adminToken = generateToken({ _id: 'admin', email: 'admin', name: 'Admin' });
    return res.json({ success: true, message: "Welcome back boss 🌿", token: adminToken });
  }
  // 2) DB-based admin accounts
  if (email) {
    try {
      const admin = await db.collection("admins").findOne({ email });
      if (admin && await bcrypt.compare(password, admin.password)) {
        const token = generateToken({ _id: admin._id, email: admin.email, name: admin.name, role: admin.role });
        return res.json({ success: true, message: `Welcome, ${admin.name}! 🌿`, token, role: admin.role });
      }
    } catch (err) { console.error("DB admin login error:", err); }
  }
  res.status(401).json({ success: false, message: "Incorrect credentials" });
});

// Middleware to protect member routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401); // No token

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Invalid token
    req.user = user;
    next();
  });
}

// Helper: Check if request is from any admin (env-based or DB-based)
function isAdmin(req) {
  return req.user.id === 'admin' || ['super_admin','owner','staff_admin'].includes(req.user.role);
}

// Tier → automatic discount %
const TIER_DISCOUNTS = { normal: 0, vip: 20, vip_plus: 50, staff: 20 };

// Audit log helper – fire and forget
async function logAudit(action, details, req) {
  try {
    await db.collection("audit_logs").insertOne({
      action,
      details,
      actorName: req.user?.name || req.user?.id || 'unknown',
      adminId: String(req.user?.id || ''),
      ip: req.ip,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('⚠️ Audit log error:', err);
  }
}

// 👤 Member login (with auth rate limiter)
app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== "string" || typeof password !== "string") return res.status(400).send("Invalid credentials");
  const member = await db.collection("members").findOne({ email });

  if (member == null) {
    return res.status(400).send("Cannot find member");
  }

  // Check for expired membership
  if (member.membershipEndDate && new Date(member.membershipEndDate) < new Date()) {
    return res.status(403).send("Membership expired");
  }

  try {
    if (await bcrypt.compare(password, member.password)) {
      const token = generateToken(member);
      res.json({ 
        user: { 
          id: member._id, 
          name: member.name, 
          email: member.email,
          balance: member.balance || 0
        }, 
        token 
      });
    } else {
      res.status(403).send("Not Allowed");
    }
  } catch (err) {
    res.status(500).send();
  }
});

// 👥 Get all members (Admin only)
app.get("/api/members", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const { tier } = req.query;
    let filter = {};
    if (tier && TIER_DISCOUNTS[tier] !== undefined) filter = { tier };
    const members = await db.collection("members").find(filter, {projection:{password:0,identityHash:0}}).toArray();
    const membersWithExpiryStatus = members.map(member => ({
      ...member,
      isExpired: new Date(member.membershipEndDate) < new Date(),
      tier: member.tier || 'normal',
      discount: member.discount !== undefined ? member.discount : (TIER_DISCOUNTS[member.tier || 'normal'] || 0)
    }));
    res.json(membersWithExpiryStatus);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch members", details: err });
  }
});

// New memberships use the registration ledger; this legacy route must not bypass it.
app.post('/api/members', authenticateToken, (req,res)=>{
  if (!isAdmin(req)) return res.status(403).json({error:'Staff access required'});
  res.status(409).json({error:'Use Registration Desk to allocate or reserve a member number.'});
});

// 🗑️ Delete a member (Admin only)
app.delete("/api/members/:id", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const id = req.params.id;
    const member = await db.collection("members").findOne({ _id: new ObjectId(id) });
    if (member?.registrationId) await deleteRegistrationData(db,new ObjectId(member.registrationId),true,true);
    await db.collection("members").deleteOne({ _id: new ObjectId(id) });
    await logAudit('member_delete', `Deleted member: ${member?.name || id}`, req);
    res.json({ success: true, message: "Member deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete member", details: err });
  }
});

// ✏️ Update a member (Admin only)
app.put("/api/members/:id", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const id = req.params.id;
    const { name, email, membershipEndDate, balance, tier } = req.body;
    const current = await db.collection("members").findOne({_id:new ObjectId(id)});
    if (current && current.email !== email && await db.collection("registration_settings").findOne({_id:"numbers"})) return res.status(409).json({error:"Member numbers cannot be changed here."});
    if (!name || !email || !membershipEndDate) {
      return res.status(400).json({ error: "Missing name, email, or membership end date" });
    }
    const resolvedTier = TIER_DISCOUNTS[tier] !== undefined ? tier : 'normal';
    const discount = TIER_DISCOUNTS[resolvedTier];
    const updateData = { 
      name, email, membershipEndDate: new Date(membershipEndDate),
      updatedAt: new Date(), tier: resolvedTier, discount
    };
    if (balance !== undefined && balance !== null) {
      updateData.balance = parseFloat(balance) || 0;
    }
    const result = await db.collection("members").updateOne(
      { _id: new ObjectId(id) }, { $set: updateData }
    );
    if (result.modifiedCount > 0 || result.matchedCount > 0) {
      await logAudit('member_update', `Updated member: ${name} tier:${resolvedTier}`, req);
      res.json({ success: true, message: "Member updated." });
    } else {
      res.status(404).json({ success: false, message: "Member not found or no changes made." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to update member", details: err });
  }
});

// 👤 Get member profile (for logged-in members)
app.get("/api/member/profile", authenticateToken, async (req, res) => {
  try {
    // Only allow members to access their own profile (not admins)
    if (req.user.id === 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const member = await db.collection("members").findOne({ _id: new ObjectId(req.user.id) });
    if (!member) {
      return res.status(404).json({ message: 'Member not found' });
    }
    
    res.json({
      id: member._id,
      name: member.name,
      email: member.email,
      balance: member.balance || 0,
      membershipEndDate: member.membershipEndDate
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch member profile", details: err });
  }
});

// 🍃 Get full menu (Protected for members)
app.get("/api/menu", authenticateToken, async (req, res) => {
  try {
    const { status } = req.query;
    let filter = {};
    if (isAdmin(req)) {
      if (status === 'active') filter = { status: { $ne: 'shelved' } };
      else if (status === 'shelved') filter = { status: 'shelved' };
      // no filter = all
    } else {
      filter = { status: { $ne: 'shelved' } };
    }
    const menu = await db.collection("menu").find(filter).toArray();
    res.json(menu);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", details: err });
  }
});

// ➕ Add new strain to menu
app.post("/api/menu", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const { strainName, type, thc, terpenes, description, category } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });
    const validCats = ['standard','top-shelf','budget','new-arrival'];
    const resolvedCategory = validCats.includes(category) ? category : 'standard';
    await db.collection("menu").insertOne({
      strainName, type, thc, terpenes, description,
      category: resolvedCategory, status: 'active',
      averageRating: 0, ratingCount: 0, addedAt: new Date(),
    });
    await logAudit('strain_add', `Added strain: ${strainName} (${resolvedCategory})`, req);
    res.json({ success: true, message: "Strain added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add menu item", details: err });
  }
});

// 🗑️ Delete a strain
app.delete("/api/menu/:id", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const id = req.params.id;
    const strain = await db.collection("menu").findOne({ _id: new ObjectId(id) });
    await db.collection("menu").deleteOne({ _id: new ObjectId(id) });
    await logAudit('strain_delete', `Deleted strain: ${strain?.strainName || id}`, req);
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete menu item", details: err });
  }
});

// ✏️ Update a strain
app.put("/api/menu/:id", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const id = req.params.id;
    const { strainName, type, thc, terpenes, description, category } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });
    const validCats = ['standard','top-shelf','budget','new-arrival'];
    const resolvedCategory = validCats.includes(category) ? category : 'standard';
    await db.collection("menu").updateOne(
      { _id: new ObjectId(id) },
      { $set: { strainName, type, thc, terpenes, description, category: resolvedCategory, updatedAt: new Date() } }
    );
    await logAudit('strain_update', `Updated strain: ${strainName}`, req);
    res.json({ success: true, message: "Menu item updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update menu item", details: err });
  }
});

// 📦 Shelve / Unshelve a strain (soft delete)
app.patch("/api/menu/:id/shelve", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const id = req.params.id;
    const strain = await db.collection("menu").findOne({ _id: new ObjectId(id) });
    if (!strain) return res.status(404).json({ error: "Strain not found" });
    const newStatus = strain.status === 'shelved' ? 'active' : 'shelved';
    await db.collection("menu").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );
    await logAudit('strain_shelve', `${newStatus === 'shelved' ? 'Shelved' : 'Unshelved'} strain: ${strain.strainName}`, req);
    res.json({ success: true, message: `Strain ${newStatus}.`, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: "Failed to update strain status", details: err });
  }
});

// ⭐ Rate a strain (authenticated members)
app.post("/api/menu/:id/rate", authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    const rating = parseInt(req.body.rating);
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be 1–5" });
    }
    const strain = await db.collection("menu").findOne({ _id: new ObjectId(id) });
    if (!strain) return res.status(404).json({ error: "Strain not found" });
    const currentCount = strain.ratingCount || 0;
    const currentAvg = strain.averageRating || 0;
    const newCount = currentCount + 1;
    const newAvg = ((currentAvg * currentCount) + rating) / newCount;
    await db.collection("menu").updateOne(
      { _id: new ObjectId(id) },
      { $set: { averageRating: Math.round(newAvg * 10) / 10, ratingCount: newCount } }
    );
    res.json({ success: true, averageRating: Math.round(newAvg * 10) / 10, ratingCount: newCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit rating", details: err });
  }
});

// 🧾 Get editable content (events/info)
app.get("/api/content", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const content = await db.collection("content").find().toArray();
    res.json(content);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch content", details: err });
  }
});

// ✏️ Update or create content section
app.post("/api/update-content", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { section, data } = req.body;
    if (!section) return res.status(400).json({ error: "Missing section name" });

    await db.collection("content").updateOne(
      { section },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, message: "Content updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update content", details: err });
  }
});

// Signup v2: private uploads, staff review and transaction-backed numbering.
app.use('/api/registration', registrationRouter({getDB:()=>db,client,authenticateToken,isAdmin,prefillLimiter,logAudit,notify:sendTelegramNotification}));
startRegistrationCleanup(()=>db);
app.post('/api/prefill', (req,res)=>res.status(409).json({error:'Please refresh the website to use the updated membership form.'}));

// ADMIN ONLY: Get all pre-fills
app.get("/api/prefills", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({error:"Staff access required"});
  res.set("Cache-Control", "private, no-store");
  try {
    const prefillData = await db.collection("prefills").find({}, {projection:{uploadTokenHash:0,submissionKey:0,idKey:0}}).sort({ ts: -1 }).toArray();
    res.json(prefillData);
  } catch (err) {
    console.error("Error fetching pre-fills:", err);
    res.status(500).send("Error fetching pre-fills");
  }
});

// Legacy deletion must not leave a private ID object behind.
app.delete('/api/prefills/:id', authenticateToken, (req,res)=>{
  if (!isAdmin(req)) return res.status(403).json({error:'Staff access required'});
  res.status(409).json({error:'Use the registration desk to delete pre-fills and their ID images.'});
});
// 📰 Members-only posts (for dashboard demo)
app.get("/api/posts", authenticateToken, async (req, res) => {
  // For members, anyone authenticated can view posts
  try {
    const posts = await db.collection("posts").find().sort({ _id: -1 }).toArray();
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch posts", details: err });
  }
});

// ➕ Add a post (for admin dashboard in future)
app.post("/api/posts", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { title, body } = req.body;
    if (!title) return res.status(400).json({ error: "Missing title" });

    await db.collection("posts").insertOne({ title, body, createdAt: new Date() });
    res.json({ success: true, message: "Post added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add post", details: err });
  }
});

// 🗓️ Get all events
app.get("/api/events", async (req, res) => {
  try {
    const events = await db.collection("events").find().sort({ date: 1 }).toArray();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch events", details: err });
  }
});

// ➕ Add a new event (Admin only)
app.post("/api/events", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { title, description, date, time } = req.body;
    if (!title || !date || !time) {
      return res.status(400).json({ error: "Missing title, date, or time" });
    }
    await db.collection("events").insertOne({ title, description, date: new Date(date), time, createdAt: new Date() });
    res.status(201).json({ success: true, message: "Event added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add event", details: err });
  }
});

// ✏️ Update an event (Admin only)
app.put("/api/events/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { title, description, date, time } = req.body;
    if (!title || !date || !time) {
      return res.status(400).json({ error: "Missing title, date, or time" });
    }
    await db.collection("events").updateOne(
      { _id: new ObjectId(id) },
      { $set: { title, description, date: new Date(date), time, updatedAt: new Date() } }
    );
    res.json({ success: true, message: "Event updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update event", details: err });
  }
});

// 🗑️ Delete an event (Admin only)
app.delete("/api/events/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("events").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Event deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete event", details: err });
  }
});

function generateToken(user) {
  return jwt.sign({ id: user._id, email: user.email, name: user.name, ...(user.role ? {role:user.role} : {}) }, JWT_SECRET, { expiresIn: "1h" });
}

// =============================================================================
// 🔐 WEBAUTHN / PASSKEY AUTHENTICATION
// =============================================================================

// Helper function to ensure credentialId/credentialPublicKey is always a string
// MongoDB might return Binary/Buffer objects, so we need to normalize them
function normalizeCredentialString(value) {
  if (!value) return '';
  if (Buffer.isBuffer(value) || value?.constructor?.name === 'Binary') {
    return value.toString('base64url');
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  return value;
}

// Get all registered passkeys (Admin only)
app.get("/api/passkeys", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const passkeys = await db.collection("passkeys").find().toArray();
    // Don't send the full credential data, just metadata
    const safePasskeys = passkeys.map(p => ({
      _id: p._id,
      staffName: p.staffName,
      deviceName: p.deviceName,
      registeredAt: p.registeredAt,
      lastUsed: p.lastUsed
    }));
    console.log(`🔐 [WEBAUTHN] Fetched ${safePasskeys.length} passkeys`);
    res.json({ passkeys: safePasskeys, maxPasskeys: WEBAUTHN_CONFIG.maxPasskeys });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error fetching passkeys:", err);
    res.status(500).json({ error: "Failed to fetch passkeys" });
  }
});

// Start passkey registration (Admin must be logged in)
app.post("/api/passkeys/register-options", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  
  try {
    const { staffName, deviceName } = req.body;
    if (!staffName || !deviceName) {
      return res.status(400).json({ error: "Missing staffName or deviceName" });
    }

    // Check passkey limit
    const existingCount = await db.collection("passkeys").countDocuments();
    if (existingCount >= WEBAUTHN_CONFIG.maxPasskeys) {
      console.warn(`🚫 [WEBAUTHN] Passkey limit reached (${existingCount}/${WEBAUTHN_CONFIG.maxPasskeys})`);
      return res.status(400).json({ error: `Maximum ${WEBAUTHN_CONFIG.maxPasskeys} passkeys allowed. Delete one to add more.` });
    }

    // Get existing credentials for this user to prevent duplicates
    const existingPasskeys = await db.collection("passkeys").find().toArray();
    const excludeCredentials = existingPasskeys.map(p => {
      const credentialIdStr = normalizeCredentialString(p.credentialId);
      // SimpleWebAuthn expects base64url string in excludeCredentials, not Uint8Array
      return {
        id: credentialIdStr,
        type: 'public-key',
      };
    });

    // Generate a unique user ID for this registration
    // User ID must be max 64 bytes per WebAuthn spec
    // Use a shorter format to ensure compatibility with mobile browsers
    const uniqueUserId = `${staffName}-${Date.now()}`;
    let userIdBytes = new TextEncoder().encode(uniqueUserId);
    
    // Truncate if too long (shouldn't happen, but safety check)
    if (userIdBytes.length > 64) {
      console.warn(`⚠️ [WEBAUTHN] User ID too long (${userIdBytes.length} bytes), truncating`);
      userIdBytes = userIdBytes.slice(0, 64);
    }

    console.log(`🔐 [WEBAUTHN] Generating options for ${staffName} with rpID: ${WEBAUTHN_CONFIG.rpID}`);
    
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_CONFIG.rpName,
      rpID: WEBAUTHN_CONFIG.rpID,
      userID: userIdBytes,
      userName: staffName,
      userDisplayName: `${staffName} (${deviceName})`,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred', // Allow both resident and non-resident keys
        userVerification: 'preferred',
        // Don't restrict authenticatorAttachment - allow both platform and cross-platform
        // This allows Google Password Manager (cross-platform) to work
      },
      // Add timeout for mobile devices (30 seconds)
      timeout: 30000,
    });
    
    console.log(`🔐 [WEBAUTHN] Registration options generated:`, {
      challenge: options.challenge ? 'present' : 'missing',
      rp: options.rp,
      user: options.user ? { name: options.user.name, displayName: options.user.displayName } : 'missing',
      excludeCredentials: excludeCredentials.length,
      authenticatorSelection: options.authenticatorSelection
    });

    // Store challenge temporarily
    const challengeId = `reg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    storeChallenge(challengeId, options.challenge);

    console.log(`✅ [WEBAUTHN] Registration options generated for ${staffName} (${deviceName})`);
    res.json({ 
      options, 
      challengeId,
      staffName,
      deviceName 
    });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error generating registration options:", err.message);
    console.error("❌ [WEBAUTHN] Full error:", err);
    res.status(500).json({ error: "Failed to generate registration options", details: err.message });
  }
});

// Complete passkey registration
app.post("/api/passkeys/register", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }

  try {
    const { challengeId, credential, staffName, deviceName } = req.body;
    
    if (!credential || !credential.response) {
      console.error(`❌ [WEBAUTHN] Invalid credential data received for ${staffName}`);
      return res.status(400).json({ error: "Invalid credential data received" });
    }
    
    console.log(`🔐 [WEBAUTHN] Verifying registration for ${staffName} (${deviceName})`);
    console.log(`🔐 [WEBAUTHN] Credential data from browser:`, {
      id: credential.id ? credential.id.substring(0, 30) + '...' : 'missing',
      rawId: credential.rawId ? credential.rawId.substring(0, 30) + '...' : 'missing',
      type: credential.type,
      hasClientDataJSON: !!credential.response.clientDataJSON,
      hasAttestationObject: !!credential.response.attestationObject,
      transports: credential.response.transports || 'none'
    });
    
    const expectedChallenge = getChallenge(challengeId);
    if (!expectedChallenge) {
      console.warn(`🚫 [WEBAUTHN] Challenge expired or invalid for ${staffName}`);
      return res.status(400).json({ error: "Challenge expired or invalid. Please try again." });
    }

    // Determine expected origin based on request
    const requestOrigin = req.headers.origin || req.headers.referer?.replace(/\/$/, '');
    const expectedOrigins = Array.isArray(WEBAUTHN_CONFIG.origin) 
      ? WEBAUTHN_CONFIG.origin 
      : [WEBAUTHN_CONFIG.origin];
    
    console.log(`🔐 [WEBAUTHN] Expected origins:`, expectedOrigins);
    console.log(`🔐 [WEBAUTHN] Request origin:`, requestOrigin);

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: WEBAUTHN_CONFIG.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      console.warn(`🚫 [WEBAUTHN] Registration verification failed for ${staffName}`);
      console.warn(`🚫 [WEBAUTHN] Verification result:`, {
        verified: verification.verified,
        hasRegistrationInfo: !!verification.registrationInfo
      });
      return res.status(400).json({ error: "Verification failed. Please try again." });
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    
    // Store both the credentialID from verification (raw bytes) and the browser's credential.id
    // The browser's credential.id might be different from credentialID, so we store both
    const storedCredentialId = Buffer.from(credentialID).toString('base64url');
    const browserCredentialId = credential.id; // This is what the browser will send back during login
    
    console.log(`🔐 [WEBAUTHN] Storing credential:`, {
      storedCredentialId: storedCredentialId.substring(0, 30) + '...',
      browserCredentialId: browserCredentialId?.substring(0, 30) + '...',
      match: storedCredentialId === browserCredentialId ? 'YES' : 'NO (will need to match both)'
    });

    // Save to database - store the credentialID from verification (this is the canonical ID)
    await db.collection("passkeys").insertOne({
      credentialId: storedCredentialId, // This is what we'll match against
      browserCredentialId: browserCredentialId, // Also store browser's ID for easier matching
      credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter,
      staffName,
      deviceName,
      registeredAt: new Date(),
      lastUsed: null
    });

    const newCount = await db.collection("passkeys").countDocuments();
    console.log(`✅ [WEBAUTHN] Passkey registered for ${staffName} (${deviceName}). Total: ${newCount}/${WEBAUTHN_CONFIG.maxPasskeys}`);
    
    res.json({ 
      success: true, 
      message: `Passkey registered for ${staffName} on ${deviceName}`,
      totalPasskeys: newCount,
      maxPasskeys: WEBAUTHN_CONFIG.maxPasskeys
    });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error verifying registration:", err);
    res.status(500).json({ error: "Failed to verify registration" });
  }
});

// Delete a passkey (Admin only)
app.delete("/api/passkeys/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  
  try {
    const { id } = req.params;
    const passkey = await db.collection("passkeys").findOne({ _id: new ObjectId(id) });
    
    if (!passkey) {
      return res.status(404).json({ error: "Passkey not found" });
    }

    await db.collection("passkeys").deleteOne({ _id: new ObjectId(id) });
    console.log(`🗑️ [WEBAUTHN] Passkey deleted: ${passkey.staffName} (${passkey.deviceName})`);
    
    res.json({ success: true, message: "Passkey deleted" });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error deleting passkey:", err);
    res.status(500).json({ error: "Failed to delete passkey" });
  }
});

// Start biometric login (no auth required - this IS the login)
app.post("/api/passkeys/login-options", async (req, res) => {
  try {
    console.log(`🔐 [WEBAUTHN] Login options requested`);
    
    const passkeys = await db.collection("passkeys").find().toArray();
    console.log(`🔐 [WEBAUTHN] Found ${passkeys.length} passkeys in database`);
    
    if (passkeys.length === 0) {
      return res.status(400).json({ error: "No passkeys registered. Login with password first." });
    }

    const allowCredentials = passkeys.map(p => {
      const credentialIdStr = normalizeCredentialString(p.credentialId);
      console.log(`🔐 [WEBAUTHN] Processing credential: ${credentialIdStr?.substring(0, 20)}...`);
      // SimpleWebAuthn expects base64url string in allowCredentials, not Uint8Array
      return {
        id: credentialIdStr,
        type: 'public-key',
      };
    });

    console.log(`🔐 [WEBAUTHN] Generating auth options with rpID: ${WEBAUTHN_CONFIG.rpID}`);
    
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_CONFIG.rpID,
      allowCredentials,
      userVerification: 'preferred',
      // Don't restrict to platform only - allow both platform and cross-platform passkeys
      // This allows Google Password Manager passkeys to work
    });

    // Store challenge temporarily
    const challengeId = `auth-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    storeChallenge(challengeId, options.challenge);

    console.log(`✅ [WEBAUTHN] Authentication options generated successfully`);
    res.json({ options, challengeId });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error generating auth options:", err.message);
    console.error("❌ [WEBAUTHN] Full error:", err);
    res.status(500).json({ error: "Failed to generate authentication options", details: err.message });
  }
});

// Complete biometric login
app.post("/api/passkeys/login", async (req, res) => {
  try {
    const { challengeId, credential } = req.body;
    
    const expectedChallenge = getChallenge(challengeId);
    if (!expectedChallenge) {
      return res.status(400).json({ error: "Challenge expired or invalid. Please try again." });
    }

    // Find the passkey by credential ID
    // The credential.id from browser is base64url string
    // We need to match it against our stored credentialId (also base64url)
    const credentialIdFromBrowser = credential.id; // This is already base64url from browser
    const credentialRawIdBase64 = credential.rawId; // This is also base64url
    
    console.log(`🔐 [WEBAUTHN] Looking for credential:`, {
      id: credentialIdFromBrowser?.substring(0, 30) + '...',
      rawId: credentialRawIdBase64?.substring(0, 30) + '...',
      idLength: credentialIdFromBrowser?.length,
      rawIdLength: credentialRawIdBase64?.length
    });
    
    // Get all passkeys and try to match
    const allPasskeys = await db.collection("passkeys").find().toArray();
    console.log(`🔐 [WEBAUTHN] Checking against ${allPasskeys.length} stored passkeys`);
    
    // Log all stored credential IDs for debugging
    console.log(`🔐 [WEBAUTHN] Stored credential IDs:`, allPasskeys.map(p => ({
      storedId: normalizeCredentialString(p.credentialId)?.substring(0, 30) + '...',
      browserId: p.browserCredentialId?.substring(0, 30) + '...',
      staffName: p.staffName,
      deviceName: p.deviceName
    })));
    
    let passkey = null;
    
    // Try multiple matching strategies
    for (const p of allPasskeys) {
      const storedId = normalizeCredentialString(p.credentialId);
      const storedBrowserId = p.browserCredentialId ? normalizeCredentialString(p.browserCredentialId) : null;
      
      // Strategy 1: Match against stored credentialId (from verification)
      if (storedId === credentialIdFromBrowser || storedId === credentialRawIdBase64) {
        passkey = p;
        console.log(`✅ [WEBAUTHN] Matched by stored credentialId`);
        break;
      }
      
      // Strategy 2: Match against browserCredentialId (from registration request)
      if (storedBrowserId && (storedBrowserId === credentialIdFromBrowser || storedBrowserId === credentialRawIdBase64)) {
        passkey = p;
        console.log(`✅ [WEBAUTHN] Matched by browserCredentialId`);
        break;
      }
      
      // Strategy 3: Compare base64url decoded bytes
      try {
        const storedBytes = Buffer.from(storedId, 'base64url');
        const browserBytes = Buffer.from(credentialIdFromBrowser || credentialRawIdBase64, 'base64url');
        if (storedBytes.equals(browserBytes)) {
          passkey = p;
          console.log(`✅ [WEBAUTHN] Matched by byte comparison`);
          break;
        }
      } catch (e) {
        // Continue to next strategy
      }
    }
    
    // If still not found, try database queries as fallback
    if (!passkey) {
      passkey = await db.collection("passkeys").findOne({ credentialId: credentialIdFromBrowser });
      if (passkey) {
        console.log(`✅ [WEBAUTHN] Matched by database query (credentialId = credential.id)`);
      }
    }
    
    if (!passkey) {
      passkey = await db.collection("passkeys").findOne({ browserCredentialId: credentialIdFromBrowser });
      if (passkey) {
        console.log(`✅ [WEBAUTHN] Matched by database query (browserCredentialId = credential.id)`);
      }
    }
    
    if (!passkey && credentialRawIdBase64) {
      passkey = await db.collection("passkeys").findOne({ credentialId: credentialRawIdBase64 });
      if (passkey) {
        console.log(`✅ [WEBAUTHN] Matched by database query (credentialId = credential.rawId)`);
      }
    }
    
    if (!passkey && credentialRawIdBase64) {
      passkey = await db.collection("passkeys").findOne({ browserCredentialId: credentialRawIdBase64 });
      if (passkey) {
        console.log(`✅ [WEBAUTHN] Matched by database query (browserCredentialId = credential.rawId)`);
      }
    }
    
    if (!passkey) {
      console.warn(`🚫 [WEBAUTHN] Unknown credential attempted login`);
      console.warn(`🚫 [WEBAUTHN] Credential ID from browser: ${credentialIdFromBrowser?.substring(0, 50)}...`);
      console.warn(`🚫 [WEBAUTHN] Stored credential IDs:`, allPasskeys.map(p => ({
        id: normalizeCredentialString(p.credentialId)?.substring(0, 30) + '...',
        staffName: p.staffName,
        deviceName: p.deviceName
      })));
      return res.status(400).json({ error: "Passkey not recognized. The passkey may have been created on a different device or account. Please register this device again." });
    }
    
    console.log(`✅ [WEBAUTHN] Found passkey: ${passkey.staffName} (${passkey.deviceName})`);

    // Determine expected origin
    const expectedOrigins = Array.isArray(WEBAUTHN_CONFIG.origin) 
      ? WEBAUTHN_CONFIG.origin 
      : [WEBAUTHN_CONFIG.origin];

    // Normalize credentialId and credentialPublicKey to strings (MongoDB might return Binary/Buffer)
    const credentialIdStr = normalizeCredentialString(passkey.credentialId);
    const credentialPublicKeyStr = normalizeCredentialString(passkey.credentialPublicKey);

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: WEBAUTHN_CONFIG.rpID,
      authenticator: {
        credentialID: new Uint8Array(Buffer.from(credentialIdStr, 'base64url')),
        credentialPublicKey: new Uint8Array(Buffer.from(credentialPublicKeyStr, 'base64url')),
        counter: passkey.counter,
      },
    });

    if (!verification.verified) {
      console.warn(`🚫 [WEBAUTHN] Authentication verification failed for ${passkey.staffName}`);
      return res.status(400).json({ error: "Authentication failed" });
    }

    // Update counter and last used
    await db.collection("passkeys").updateOne(
      { _id: passkey._id },
      { 
        $set: { 
          counter: verification.authenticationInfo.newCounter,
          lastUsed: new Date()
        }
      }
    );

    // Generate admin token (same as password login)
    const adminToken = generateToken({ _id: 'admin', email: 'admin', name: passkey.staffName });
    
    console.log(`✅ [WEBAUTHN] Biometric login successful: ${passkey.staffName} (${passkey.deviceName})`);
    res.json({ 
      success: true, 
      message: `Welcome back, ${passkey.staffName}! 🔐`,
      token: adminToken,
      staffName: passkey.staffName
    });
  } catch (err) {
    console.error("❌ [WEBAUTHN] Error verifying authentication:", err);
    res.status(500).json({ error: "Failed to verify authentication" });
  }
});

// Check if any passkeys are registered (public - for showing biometric login button)
app.get("/api/passkeys/available", async (req, res) => {
  try {
    const count = await db.collection("passkeys").countDocuments();
    res.json({ available: count > 0, count });
  } catch (err) {
    res.json({ available: false, count: 0 });
  }
});

// =============================================================================
// 📊 DASHBOARD (Phase 5)
// =============================================================================

app.get("/api/dashboard/stats", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const [totalMembers, activeStrains, shelvedStrains, upcomingEvents, pendingPrefills] = await Promise.all([
      db.collection("members").countDocuments(),
      db.collection("menu").countDocuments({ status: { $ne: 'shelved' } }),
      db.collection("menu").countDocuments({ status: 'shelved' }),
      db.collection("events").countDocuments({ date: { $gte: new Date() } }),
      db.collection("prefills").countDocuments({ status: "pending" })
    ]);
    res.json({ totalMembers, activeStrains, shelvedStrains, upcomingEvents, pendingPrefills });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats", details: err });
  }
});

app.get("/api/dashboard/activity", authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Access denied' });
  try {
    const activity = await db.collection("audit_logs").find().sort({ timestamp: -1 }).limit(20).toArray();
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity", details: err });
  }
});

// =============================================================================
// 👑 ADMIN MANAGEMENT (Multi-admin support)
// =============================================================================

app.get("/api/admins", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const admins = await db.collection("admins").find({}, { projection: { password: 0 } }).toArray();
    res.json(admins);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch admins", details: err });
  }
});

app.post("/api/admins", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing required fields" });
    const validRoles = ['super_admin','owner','staff_admin'];
    const resolvedRole = validRoles.includes(role) ? role : 'staff_admin';
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.collection("admins").insertOne({
      name, email, password: hashedPassword, role: resolvedRole, createdAt: new Date()
    });
    await logAudit('admin_add', `Added admin: ${name} (${resolvedRole})`, req);
    res.status(201).json({ success: true, message: "Admin added.", adminId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Failed to add admin", details: err });
  }
});

app.delete("/api/admins/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { id } = req.params;
    const admin = await db.collection("admins").findOne({ _id: new ObjectId(id) });
    if (!admin) return res.status(404).json({ error: "Admin not found" });
    await db.collection("admins").deleteOne({ _id: new ObjectId(id) });
    await logAudit('admin_delete', `Deleted admin: ${admin.name}`, req);
    res.json({ success: true, message: "Admin deleted." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete admin", details: err });
  }
});

// 🖥️ Server setup
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("=".repeat(60));
  console.log(`🚀 SERVER STARTED SUCCESSFULLY`);
  console.log(`📍 Port: ${port}`);
  console.log(`🔒 Security: Helmet, CORS, Rate Limiting ACTIVE`);
  console.log(`⚡ Performance: Compression ENABLED`);
  console.log(`💚 Health check: /health`);
  console.log("=".repeat(60));
});
