// server.cjs
const express = require("express");
const cors = require("cors");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware
app.use(cors());
app.use(express.json());
// Serve static files from the current folder (so /contact-pay.html works)
app.use(express.static(__dirname));

// --- Helper: normalize weird urls like //p16...
function normalizeUrl(u) {
  if (!u) return null;
  let url = String(u).trim();
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

// --- Proxy Image (important: TikTok blocks hotlinking)
app.get("/proxy-image", async (req, res) => {
  try {
    let imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url");

    imageUrl = normalizeUrl(imageUrl);

    // Use native fetch (Node 18+). If you are on Node <18, install node-fetch.
    const r = await fetch(imageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        referer: "https://www.tiktok.com/",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!r.ok) {
      return res.status(502).send(`proxy failed: ${r.status}`);
    }

    const contentType = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    // Stream response
    const arrayBuffer = await r.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("proxy-image error:", e);
    res.status(500).send("proxy error");
  }
});

// --- TikTok: fetch PFP with Playwright (bypasses "blocked: true")
app.get("/tiktok", async (req, res) => {
  let user = (req.query.user || "").toString().trim();
  if (!user) return res.status(400).json({ error: "Missing username" });

  user = user.replace(/^@/, "");
  const profileUrl = `https://www.tiktok.com/@${user}?lang=en`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      locale: "en-US",
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Method 1: og:image meta
    let avatar = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content")
      .catch(() => null);

    // Method 2: scan HTML for avatar fields
    if (!avatar) {
      const html = await page.content();
      const m =
        html.match(/"avatarLarger":"([^"]+)"/) ||
        html.match(/"avatarMedium":"([^"]+)"/) ||
        html.match(/"avatarThumb":"([^"]+)"/);
      if (m) avatar = m[1];
    }

    if (avatar) {
      avatar = avatar
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");

      avatar = normalizeUrl(avatar);

      return res.json({
        name: user,
        avatar: `/proxy-image?url=${encodeURIComponent(avatar)}`,
        blocked: false,
      });
    }

    // If still not found, likely captcha/blocked
    return res.json({ name: user, avatar: null, blocked: true });
  } catch (e) {
    console.error("TikTok Playwright error:", e);
    return res.status(500).json({ error: "TikTok fetch failed", details: String(e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// --- Cash endpoint (Now updated to fetch real names/PFPs)
app.get("/cash", async (req, res) => {
  try {
    let tag = (req.query.tag || "").toString().trim();
    if (!tag) return res.status(400).json({ error: "Missing tag" });

    // Ensure it starts with $ for the URL
    const cashtag = tag.startsWith("$") ? tag : `$${tag}`;
    const profileUrl = `https://cash.app/${cashtag}`;

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Extract Display Name from og:title (usually "Pay $name on Cash App")
      let fullName = await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null);
      if (fullName) {
        fullName = fullName.replace("Pay ", "").replace(" on Cash App", "");
      }

      // Extract Avatar from og:image
      let avatar = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);

      if (avatar && !avatar.includes("default_profile")) {
        avatar = normalizeUrl(avatar);
        return res.json({
          name: fullName || tag.replace(/^\$/, ""),
          avatar: `/proxy-image?url=${encodeURIComponent(avatar)}`,
          success: true
        });
      }

      // Fallback if no custom PFP is set
      res.json({ name: fullName || tag.replace(/^\$/, ""), avatar: null });
    } catch (browserError) {
      console.error("CashApp Browser error:", browserError);
      res.status(500).json({ error: "Browser fetch failed" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  } catch (e) {
    console.error("cash error:", e);
    res.status(500).json({ error: "cash failed" });
  }
});

// --- Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/tiktok?user=@tiktok`);
});