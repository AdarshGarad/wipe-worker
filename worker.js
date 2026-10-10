// Wipe worker: takes queued removal tasks from Supabase and tries the broker opt-out.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "node:fs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase env vars");

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MAX_ATTEMPTS = 3;
const BATCH = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claimTasks() {
  const { data: queued, error } = await db
    .from("removal_tasks")
    .select("id")
    .eq("status", "queued")
    .or(`next_check_at.is.null,next_check_at.lte.${new Date().toISOString()}`)
    .limit(BATCH);
  if (error) throw error;
  const claimed = [];
  for (const t of queued) {
    const { data } = await db
      .from("removal_tasks")
      .update({ status: "in_progress" })
      .eq("id", t.id)
      .eq("status", "queued")
      .select("*, brokers(slug,name,optout_url), listings(listing_url)")
      .single();
    if (data) claimed.push(data);
  }
  return claimed;
}

async function hasCaptcha(page) {
  return (await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]').count()) > 0;
}

const handlers = {
  async spokeo(page, task, email) {
    const url = task.listings?.listing_url;
    if (!url) return { status: "needs_user", error: "No listing URL for this broker" };
    await page.goto(task.brokers.optout_url, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="url"], input[name*="url" i], input[placeholder*="spokeo.com" i]').first().fill(url);
    await page.locator('input[type="email"]').first().fill(email);
    if (await hasCaptcha(page)) return { status: "needs_user", error: "captcha" };
    await page.getByRole("button", { name: /remove|submit|opt/i }).first().click();
    await page.waitForTimeout(3000);
    if (await hasCaptcha(page)) return { status: "needs_user", error: "captcha" };
    return { status: "awaiting_verification" };
  },
};

async function processTask(browser, task) {
  const handler = handlers[task.brokers.slug];
  if (!handler) return { status: "needs_user", error: `No automation yet for ${task.brokers.slug}` };

  const { data: u, error } = await db.auth.admin.getUserById(task.user_id);
  if (error || !u?.user?.email) return { status: "failed", error: "No user email" };

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await handler(page, task, u.user.email);
  } finally {
    await context.close();
  }
}

async function main() {
  const tasks = await claimTasks();
  console.log(`Claimed ${tasks.length} task(s)`);
  if (!tasks.length) return;
  const browser = await chromium.launch();
  try {
    for (const task of tasks) {
      let result;
      try {
        result = await processTask(browser, task);
      } catch (e) {
        const attempts = task.attempts + 1;
        result = attempts >= MAX_ATTEMPTS
          ? { status: "failed", error: String(e.message).slice(0, 300) }
          : { status: "queued", error: String(e.message).slice(0, 300), retry: true };
      }
      await db.from("removal_tasks").update({
        status: result.status,
        last_error: result.error ?? null,
        attempts: task.attempts + 1,
        next_check_at: result.retry ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null,
      }).eq("id", task.id);
      console.log(`Task ${task.id} (${task.brokers.slug}): ${result.status}`);
      await sleep(5000 + Math.random() * 5000);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
