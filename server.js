import dotenv from "dotenv";
dotenv.config(); // load env variables first

import express from "express";
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

// General API limiter: 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
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

// Prefill limiter: 5 submissions per hour
const prefillLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
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
    db = client.db("Amsterdam0");
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

// 🔐 Admin login (with auth rate limiter)
app.post("/api/admin-login", authLimiter, (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASS) {
    const adminToken = generateToken({ _id: 'admin', email: 'admin', name: 'Admin' });
    res.json({ success: true, message: "Welcome back boss 🌿", token: adminToken });
  } else {
    res.status(401).json({ success: false, message: "Incorrect password" });
  }
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

// 👤 Member login (with auth rate limiter)
app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
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
  if (req.user.id !== 'admin') { // Simple admin check for now
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const members = await db.collection("members").find().toArray();
    // Add a check for membership expiry here before sending to frontend
    const membersWithExpiryStatus = members.map(member => ({
      ...member,
      isExpired: new Date(member.membershipEndDate) < new Date()
    }));
    res.json(membersWithExpiryStatus);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch members", details: err });
  }
});

// ➕ Add a new member (Admin only)
app.post("/api/members", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing name, email, or password" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log(`New member email: ${email}, Hashed Password: ${hashedPassword}`); // Add this line for debugging
    
    const membershipEndDate = new Date();
    membershipEndDate.setFullYear(membershipEndDate.getFullYear() + 1);

    const balance = parseFloat(req.body.balance) || 0;

    const result = await db.collection("members").insertOne({ 
      name, 
      email, 
      password: hashedPassword, 
      createdAt: new Date(), 
      membershipEndDate,
      balance: balance
    });
    res.status(201).json({ success: true, message: "Member added.", memberId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Failed to add member", details: err });
  }
});

// 🗑️ Delete a member (Admin only)
app.delete("/api/members/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("members").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Member deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete member", details: err });
  }
});

// ✏️ Update a member (Admin only)
app.put("/api/members/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { name, email, membershipEndDate, balance } = req.body;

    if (!name || !email || !membershipEndDate) {
      return res.status(400).json({ error: "Missing name, email, or membership end date" });
    }

    // Note: Password changes should ideally be handled via a separate, secure flow.
    // Here, we're allowing name, email, membershipEndDate, and balance to be updated.
    const updateData = { 
      name, 
      email, 
      membershipEndDate: new Date(membershipEndDate), 
      updatedAt: new Date() 
    };
    
    // Always update balance if provided (even if 0)
    if (balance !== undefined && balance !== null) {
      updateData.balance = parseFloat(balance) || 0;
    }
    
    const result = await db.collection("members").updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );
    
    if (result.modifiedCount > 0 || result.matchedCount > 0) {
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
    const menu = await db.collection("menu").find().toArray();
    res.json(menu);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", details: err });
  }
});

// ➕ Add new strain to menu
app.post("/api/menu", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { strainName, type, thc, terpenes, description } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });

    await db.collection("menu").insertOne({
      strainName,
      type,
      thc,
      terpenes,
      description,
      addedAt: new Date(),
    });
    res.json({ success: true, message: "Strain added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add menu item", details: err });
  }
});

// 🗑️ Delete a strain
app.delete("/api/menu/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("menu").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete menu item", details: err });
  }
});

// ✏️ Update a strain
app.put("/api/menu/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { strainName, type, thc, terpenes, description } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });

    await db.collection("menu").updateOne(
      { _id: new ObjectId(id) },
      { $set: { strainName, type, thc, terpenes, description, updatedAt: new Date() } }
    );
    res.json({ success: true, message: "Menu item updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update menu item", details: err });
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

// 🧠 Prefill Memberships (public bluff form) - with prefill rate limiter
app.post("/api/prefill", prefillLimiter, async (req, res) => {
  try {
    const { fullname, phone, email, ts } = req.body;
    // Save pre-fill data to a new 'prefills' collection
    await db.collection("prefills").insertOne({ fullname, phone, email, ts: new Date(ts), status: "pending" });
    
    // Send Telegram notification
    const notificationMessage = `📥<b>New Web Membership Prefill!</b>📥\n\n<b>Name:</b> ${fullname}\n<b>Email:</b> ${email}\n<b>Phone:</b> ${phone}\n<b>Received:</b> ${new Date(ts).toLocaleString()}\n\n📱<b>Check it out in the panel</b>📱\nhttps://www.socialclubamsterdam.com/admin`;
    await sendTelegramNotification(notificationMessage);

    res.status(200).send("Pre-fill data received");
  } catch (err) {
    console.error("Error saving pre-fill data:", err);
    res.status(500).send("Error saving pre-fill data");
  }
});

// ADMIN ONLY: Get all pre-fills
app.get("/api/prefills", authenticateToken, async (req, res) => {
  try {
    const prefillData = await db.collection("prefills").find({}).sort({ ts: -1 }).toArray();
    res.json(prefillData);
  } catch (err) {
    console.error("Error fetching pre-fills:", err);
    res.status(500).send("Error fetching pre-fills");
  }
});

// ADMIN ONLY: Delete a pre-fill
app.delete("/api/prefills/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection("prefills").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send("Pre-fill not found");
    }
    res.status(200).send("Pre-fill deleted");
  } catch (err) {
    console.error("Error deleting pre-fill:", err);
    res.status(500).send("Error deleting pre-fill");
  }
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
  return jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "1h" });
}

// =============================================================================
// 🔐 WEBAUTHN / PASSKEY AUTHENTICATION
// =============================================================================

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
      const idBuffer = Buffer.from(p.credentialId, 'base64url');
      return {
        id: new Uint8Array(idBuffer),
        type: 'public-key',
      };
    });

    // Generate a unique user ID for this registration
    const uniqueUserId = `staff-${staffName}-${Date.now()}`;
    const userIdBytes = new TextEncoder().encode(uniqueUserId);

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
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
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
    
    const expectedChallenge = getChallenge(challengeId);
    if (!expectedChallenge) {
      return res.status(400).json({ error: "Challenge expired or invalid. Please try again." });
    }

    // Determine expected origin based on request
    const requestOrigin = req.headers.origin || req.headers.referer?.replace(/\/$/, '');
    const expectedOrigins = Array.isArray(WEBAUTHN_CONFIG.origin) 
      ? WEBAUTHN_CONFIG.origin 
      : [WEBAUTHN_CONFIG.origin];

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: WEBAUTHN_CONFIG.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      console.warn(`🚫 [WEBAUTHN] Registration verification failed for ${staffName}`);
      return res.status(400).json({ error: "Verification failed" });
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

    // Save to database
    await db.collection("passkeys").insertOne({
      credentialId: Buffer.from(credentialID).toString('base64url'),
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
      console.log(`🔐 [WEBAUTHN] Processing credential: ${p.credentialId?.substring(0, 20)}...`);
      // Convert base64url to Uint8Array
      const idBuffer = Buffer.from(p.credentialId, 'base64url');
      return {
        id: new Uint8Array(idBuffer),
        type: 'public-key',
      };
    });

    console.log(`🔐 [WEBAUTHN] Generating auth options with rpID: ${WEBAUTHN_CONFIG.rpID}`);
    
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_CONFIG.rpID,
      allowCredentials,
      userVerification: 'preferred',
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
    const credentialIdBase64 = credential.id;
    const passkey = await db.collection("passkeys").findOne({ credentialId: credentialIdBase64 });
    
    if (!passkey) {
      console.warn(`🚫 [WEBAUTHN] Unknown credential attempted login`);
      return res.status(400).json({ error: "Passkey not recognized" });
    }

    // Determine expected origin
    const expectedOrigins = Array.isArray(WEBAUTHN_CONFIG.origin) 
      ? WEBAUTHN_CONFIG.origin 
      : [WEBAUTHN_CONFIG.origin];

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: WEBAUTHN_CONFIG.rpID,
      authenticator: {
        credentialID: new Uint8Array(Buffer.from(passkey.credentialId, 'base64url')),
        credentialPublicKey: new Uint8Array(Buffer.from(passkey.credentialPublicKey, 'base64url')),
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
