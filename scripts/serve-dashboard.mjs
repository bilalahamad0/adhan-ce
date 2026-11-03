#!/usr/bin/env node
/**
 * serve-dashboard.mjs
 *
 * Local server hosting the Adhan Focus Multi-Browser Analytics Dashboard with
 * real-time stats, live API refresh, and automatic background polling.
 *
 * Usage:
 *   node scripts/serve-dashboard.mjs [--port=4321]
 *   npm run dashboard
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchConsolidatedMetrics } from './fetch-store-metrics.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.PORT || '4321', 10);

// In-memory cached metrics
let cachedMetrics = null;
let lastFetchTime = 0;
let isFetching = false;

// Load initial data
function loadInitialMetrics() {
  const jsonPath = join(REPO, 'store-metrics.json');
  if (existsSync(jsonPath)) {
    try {
      cachedMetrics = JSON.parse(readFileSync(jsonPath, 'utf8'));
      lastFetchTime = new Date(cachedMetrics.fetchedAt).getTime() || Date.now();
    } catch (_) {}
  }
}
loadInitialMetrics();

// Helper to refresh metrics
async function refreshMetrics() {
  if (isFetching) return cachedMetrics;
  isFetching = true;
  try {
    const data = await fetchConsolidatedMetrics({ saveToFile: true });
    cachedMetrics = data;
    lastFetchTime = Date.now();
    return data;
  } finally {
    isFetching = false;
  }
}

// Generate the Real-Time Dynamic Dashboard HTML
function getDashboardHtml() {
  const initialJson = JSON.stringify(cachedMetrics || {});
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Adhan Focus — Multi-Browser Active Users & Telematics (Live Localhost)</title>
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <style>
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(150, 150, 150, 0.25); border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(150, 150, 150, 0.45); }
    @keyframes highlight {
      0% { background-color: rgba(16, 185, 129, 0.25); }
      100% { background-color: transparent; }
    }
    .data-pulse { animation: highlight 1.2s ease-out; }
  </style>
</head>
<body class="bg-[var(--background,#0b0f17)] text-[var(--foreground,#f1f5f9)] antialiased min-h-screen p-4 sm:p-6 lg:p-8 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">

    <!-- Live Server Banner -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
        <span class="font-semibold text-emerald-300">Live Localhost Server Active:</span>
        <span class="font-mono text-emerald-400">http://localhost:${PORT}</span>
      </div>
      <div class="flex items-center gap-3">
        <span id="tickerTime" class="text-[var(--muted-foreground,#94a3b8)]">Refreshed just now</span>
        <label class="flex items-center gap-1.5 cursor-pointer select-none text-[var(--muted-foreground,#94a3b8)] hover:text-white">
          <input type="checkbox" id="autoRefreshToggle" checked class="rounded border-slate-700 text-emerald-500 focus:ring-0">
          <span>Auto-refresh (30s)</span>
        </label>
      </div>
    </div>

    <!-- Header Section -->
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--border,rgba(255,255,255,0.08))] pb-6">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-white font-bold text-xl">
          🕌
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-2xl sm:text-3xl font-bold tracking-tight">Adhan Focus</h1>
            <span id="headerVersion" class="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">v2.1.1</span>
            <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">Real-Time Stats</span>
          </div>
          <p class="text-sm text-[var(--muted-foreground,#94a3b8)] mt-0.5">
            Active Users Across All Browsers, Store Telemetry & Local Telematics
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <button id="refreshBtn" onclick="triggerRefresh()" class="px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 transition flex items-center gap-2">
          <svg id="refreshSpinner" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          <span id="refreshBtnText">Refresh Real-Time Stats</span>
        </button>
        <button onclick="copyMetricsJson()" class="px-3 py-2 text-xs font-medium rounded-lg bg-[var(--card,#131b2e)] hover:bg-slate-800 text-[var(--foreground,#f1f5f9)] border border-[var(--border,rgba(255,255,255,0.08))] transition flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
          <span id="copyBtnText">Copy JSON</span>
        </button>
      </div>
    </header>

    <!-- Top KPI Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Total Active Users Range -->
      <div id="cardTotalUsers" class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 relative overflow-hidden group">
        <div class="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition"></div>
        <div class="flex items-center justify-between text-xs text-[var(--muted-foreground,#94a3b8)]">
          <span>Total Cross-Platform Users</span>
          <span class="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono text-[10px]">ALL STORES</span>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="kpiTotalUsers" class="text-3xl sm:text-4xl font-extrabold tracking-tight text-emerald-400">15 – 18</span>
          <span class="text-xs text-[var(--muted-foreground,#94a3b8)]">active users</span>
        </div>
        <p class="mt-2 text-xs text-[var(--muted-foreground,#94a3b8)]">
          Consolidated across Chrome (14–17), Firefox (1), and Edge (0).
        </p>
      </div>

      <!-- Chrome Active Users -->
      <div id="cardChromeUsers" class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 relative overflow-hidden group">
        <div class="absolute top-0 right-0 w-24 h-24 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition"></div>
        <div class="flex items-center justify-between text-xs text-[var(--muted-foreground,#94a3b8)]">
          <span class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-blue-400"></span> Google Chrome
          </span>
          <span class="text-xs text-blue-400 font-mono">CWS</span>
        </div>
        <div class="mt-3 flex items-baseline gap-3">
          <div>
            <span id="kpiChromePublic" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">17</span>
            <span class="text-[10px] text-[var(--muted-foreground,#94a3b8)] block">Public Store</span>
          </div>
          <span class="text-xl text-[var(--muted-foreground,#94a3b8)] font-light">/</span>
          <div>
            <span id="kpiChromeDev" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-blue-400">14</span>
            <span class="text-[10px] text-[var(--muted-foreground,#94a3b8)] block">Dev Console</span>
          </div>
        </div>
        <p id="kpiChromeRating" class="mt-2 text-xs text-[var(--muted-foreground,#94a3b8)]">
          0 out of 5 stars (No ratings yet) · 7-day WAU vs DAU telemetry.
        </p>
      </div>

      <!-- Firefox Active Users -->
      <div id="cardFirefoxUsers" class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 relative overflow-hidden group">
        <div class="absolute top-0 right-0 w-24 h-24 bg-orange-500/10 rounded-full blur-2xl group-hover:bg-orange-500/20 transition"></div>
        <div class="flex items-center justify-between text-xs text-[var(--muted-foreground,#94a3b8)]">
          <span class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-orange-400"></span> Mozilla Firefox
          </span>
          <span class="text-xs text-orange-400 font-mono">AMO API</span>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="kpiFirefoxAdu" class="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">1</span>
          <span class="text-xs text-[var(--muted-foreground,#94a3b8)]">average daily user (ADU)</span>
        </div>
        <p id="kpiFirefoxDownloads" class="mt-2 text-xs text-[var(--muted-foreground,#94a3b8)]">
          1 weekly download · Rolling 7-day average of daily update pings.
        </p>
      </div>

      <!-- Edge Active Installs -->
      <div id="cardEdgeUsers" class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 relative overflow-hidden group">
        <div class="absolute top-0 right-0 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl group-hover:bg-cyan-500/20 transition"></div>
        <div class="flex items-center justify-between text-xs text-[var(--muted-foreground,#94a3b8)]">
          <span class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-cyan-400"></span> Microsoft Edge
          </span>
          <span class="text-xs text-cyan-400 font-mono">Catalog API</span>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="kpiEdgeInstalls" class="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">0</span>
          <span class="text-xs text-[var(--muted-foreground,#94a3b8)]">active installs</span>
        </div>
        <p class="mt-2 text-xs text-[var(--muted-foreground,#94a3b8)]">
          Live on Edge Add-ons · Product ID: kapmpaofgphfbkpkmhhiooafplhckblg.
        </p>
      </div>
    </div>

    <!-- Platform Breakdown Cards -->
    <div class="space-y-4">
      <h2 class="text-lg font-semibold flex items-center gap-2">
        <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
        Browser Store Platform Breakdown
      </h2>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <!-- 1. Chrome Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🌐</span>
                <h3 class="font-bold text-base text-white">Google Chrome</h3>
              </div>
              <span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Live</span>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Public Listing Users:</span>
                  <span id="detailChromePublic" class="font-bold text-white text-sm">17 users</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Developer Console:</span>
                  <span id="detailChromeDev" class="font-bold text-blue-400 text-sm">14 active users</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Listing Rating:</span>
                  <span id="detailChromeRating" class="text-slate-400 font-semibold">0 out of 5 (No ratings)</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Store Version:</span>
                  <span id="detailChromeVersion" class="font-mono text-white">v2.1.0</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">Measurement:</strong> Weekly Active Users (WAU, public tier) vs. Daily Heartbeat (Dev Console).</p>
                <p><strong class="text-white">Package:</strong> Signed CRX3 with verified uploads key.</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://chromewebstore.google.com/detail/adhan-focus-muslim-prayer/jfjknglldcdminelckmmfdbnlikiogia" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition flex items-center justify-center gap-1.5">
              <span>View Chrome Web Store</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <a href="https://chrome.google.com/webstore/devconsole/1441ca88-135b-4f7f-8ea0-a310657241d9/jfjknglldcdminelckmmfdbnlikiogia/analytics/users" target="_blank" class="w-full text-center px-3 py-1.5 text-xs text-[var(--muted-foreground,#94a3b8)] hover:text-white transition flex items-center justify-center gap-1">
              <span>Open Dev Console Analytics ↗</span>
            </a>
          </div>
        </div>

        <!-- 2. Firefox Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🦊</span>
                <h3 class="font-bold text-base text-white">Mozilla Firefox</h3>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Live</span>
                <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">📱 Android Ready</span>
              </div>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Average Daily Users (ADU):</span>
                  <span id="detailFirefoxAdu" class="font-bold text-white text-sm">1 user</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Weekly Downloads:</span>
                  <span id="detailFirefoxDownloads" class="font-bold text-orange-400 text-sm">1 download</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Listing Rating:</span>
                  <span id="detailFirefoxRating" class="text-[var(--muted-foreground,#94a3b8)] font-semibold">0.0 (0 reviews)</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Platform Support:</span>
                  <span class="font-medium text-emerald-400">Desktop &amp; Android (Mobile)</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Store Version:</span>
                  <span id="detailFirefoxVersion" class="font-mono text-white">v2.1.0</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">API Endpoint:</strong> Public AMO REST API v5 (queried live on localhost).</p>
                <p><strong class="text-white">Package:</strong> Unified Signed XPI (<code class="text-orange-300">gecko_android</code> min v142.0).</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://addons.mozilla.org/en-US/firefox/addon/adhan-caster-prayer-times/" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/30 transition flex items-center justify-center gap-1.5">
              <span>View Firefox Desktop AMO</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <a href="https://addons.mozilla.org/en-US/android/addon/adhan-caster-prayer-times/" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 transition flex items-center justify-center gap-1.5">
              <span>📱 View Firefox Android AMO</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <a href="/api/metrics" target="_blank" class="w-full text-center px-3 py-1.5 text-xs text-[var(--muted-foreground,#94a3b8)] hover:text-white transition flex items-center justify-center gap-1">
              <span>View Localhost Metrics API ↗</span>
            </a>
          </div>
        </div>

        <!-- 3. Edge Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🌊</span>
                <h3 class="font-bold text-base text-white">Microsoft Edge</h3>
              </div>
              <span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Live</span>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Active Install Count:</span>
                  <span id="detailEdgeInstalls" class="font-bold text-white text-sm">0 installs</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Listing Rating:</span>
                  <span id="detailEdgeRating" class="text-[var(--muted-foreground,#94a3b8)] font-semibold">0.0 (0 reviews)</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Developer:</span>
                  <span class="text-white font-medium">Bilal Ahamad</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Store Version:</span>
                  <span id="detailEdgeVersion" class="font-mono text-white">v2.1.0</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">API Endpoint:</strong> Edge catalog endpoint (queried live on localhost).</p>
                <p><strong class="text-white">Package:</strong> Unsigned ZIP with gecko keys cleanly stripped.</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://microsoftedge.microsoft.com/addons/detail/adhan-caster-muslim-pray/kapmpaofgphfbkpkmhhiooafplhckblg" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 transition flex items-center justify-center gap-1.5">
              <span>View Edge Add-ons Listing</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <a href="https://partner.microsoft.com/dashboard/microsoftedge/" target="_blank" class="w-full text-center px-3 py-1.5 text-xs text-[var(--muted-foreground,#94a3b8)] hover:text-white transition flex items-center justify-center gap-1">
              <span>Open Partner Center Analytics ↗</span>
            </a>
          </div>
        </div>

        <!-- 4. Opera Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🔴</span>
                <h3 class="font-bold text-base text-white">Opera Add-ons</h3>
              </div>
              <span id="detailOperaBadge" class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">In Moderation</span>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Package ID:</span>
                  <span id="detailOperaPkgId" class="font-mono text-white text-xs">306857</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Status:</span>
                  <span id="detailOperaStatus" class="text-amber-400 font-semibold">In Review / Auto-Publish</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Store ID:</span>
                  <span class="font-mono text-slate-400 text-[10px] truncate max-w-[140px]">ihapdbcdjejganglngampmdkeehonimn</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Store Version:</span>
                  <span id="detailOperaVersion" class="font-mono text-white">v2.1.0</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">Active Users &amp; Telematics:</strong> Monitored via Opera Developer Stats tab.</p>
                <p><strong class="text-white">Auto-Publish:</strong> Opted in for automated static security analysis.</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://addons.opera.com/developer/package/306857/?tab=stats" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 transition flex items-center justify-center gap-1.5">
              <span>📊 View Opera Stats &amp; Active Users</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <a href="https://addons.opera.com/developer/package/306857/?tab=versions" target="_blank" class="w-full text-center px-3 py-1.5 text-xs text-[var(--muted-foreground,#94a3b8)] hover:text-white transition flex items-center justify-center gap-1">
              <span>Upload Next Version / Auto-Publish ↗</span>
            </a>
            <a href="https://addons.opera.com/extensions/details/adhan-focus-muslim-prayer-times-auto-pause/" target="_blank" class="w-full text-center px-3 py-1.5 text-[11px] text-slate-500 hover:text-slate-300 transition flex items-center justify-center gap-1">
              <span>Public Store Listing ↗</span>
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- 🚀 Growth & Acquisition Engine (Product Hunt & AlternativeTo) -->
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-white flex items-center gap-2">
            <span>🚀</span> Organic Growth &amp; Acquisition Channels
          </h2>
          <p class="text-xs text-[var(--muted-foreground,#94a3b8)]">
            Active growth engines solving the "0 reviews / cold start" problem by driving verified organic adopters.
          </p>
        </div>
        <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">Item 4 in Roadmap</span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <!-- Product Hunt Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🅿️</span>
                <h3 class="font-bold text-base text-white">Product Hunt</h3>
              </div>
              <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">Assets &amp; Kit Ready</span>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Target Audience:</span>
                  <span class="font-medium text-white">Early Adopters &amp; Devs</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Gallery Assets:</span>
                  <span class="font-mono text-orange-400 text-xs">6 slides (1270x760) generated</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Launch Playbook:</span>
                  <span class="font-medium text-emerald-400">docs/growth-launch-kit.md</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Ideal Launch Time:</span>
                  <span class="font-mono text-white text-xs">12:01 AM PT (Tue-Thu)</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">Goal:</strong> Drive 50–200+ launch-day installs and capture early reviews to kickstart store rankings.</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://www.producthunt.com/products" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/30 transition flex items-center justify-center gap-1.5">
              <span>Submit to Product Hunt</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
          </div>
        </div>

        <!-- AlternativeTo Card -->
        <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xl">🔄</span>
                <h3 class="font-bold text-base text-white">AlternativeTo</h3>
              </div>
              <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">SEO Evergreen</span>
            </div>

            <div class="mt-4 space-y-3">
              <div class="p-3 rounded-xl bg-slate-900/60 border border-[var(--border,rgba(255,255,255,0.05))] space-y-1.5">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">SEO Keyword Hook:</span>
                  <span class="font-medium text-white">"Muslim Pro Alternative"</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Listing Icon:</span>
                  <span class="font-mono text-blue-400 text-xs">512x512 PNG generated</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">Competitors Mapped:</span>
                  <span class="font-medium text-emerald-400">Muslim Pro, Athan, Pillars</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                  <span class="text-[var(--muted-foreground,#94a3b8)]">License:</span>
                  <span class="font-mono text-white text-xs">Open Source (MIT)</span>
                </div>
              </div>

              <div class="text-xs text-[var(--muted-foreground,#94a3b8)] space-y-1">
                <p><strong class="text-white">Goal:</strong> Rank #1/#2 on Google search for privacy-conscious users fleeing bloated, ad-supported apps.</p>
              </div>
            </div>
          </div>

          <div class="pt-3 border-t border-[var(--border,rgba(255,255,255,0.08))] flex flex-col gap-2">
            <a href="https://alternativeto.net/" target="_blank" class="w-full text-center px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition flex items-center justify-center gap-1.5">
              <span>Submit to AlternativeTo</span>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- Explainer: Why Chrome Public (17) vs Dev Console (14) -->
    <div class="bg-gradient-to-r from-blue-950/40 via-indigo-950/30 to-purple-950/40 border border-blue-500/20 rounded-2xl p-6">
      <div class="flex items-start gap-3">
        <span class="text-2xl mt-0.5">🔍</span>
        <div class="space-y-2">
          <h3 class="text-base font-bold text-white">Why Does Chrome Show 17 Users on the Web Store and 14 in the Dev Console?</h3>
          <p class="text-sm text-slate-300 leading-relaxed">
            This is a normal difference in how Google computes and distributes extension telemetry:
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-700/50">
              <span class="text-xs font-bold text-blue-400 block mb-1">Public Web Store: 17 Users</span>
              <p class="text-xs text-slate-300">
                Calculated on a <strong>Weekly Active Users (WAU)</strong> window. For privacy and anti-deanonymization, Google rounds or buckets active user numbers in public listings. Public numbers are updated on a delayed cache cycle (~24-48h).
              </p>
            </div>
            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-700/50">
              <span class="text-xs font-bold text-purple-400 block mb-1">Developer Console: 14 Active Users</span>
              <p class="text-xs text-slate-300">
                Measures <strong>exact daily heartbeat pings</strong> from active browser instances running the extension. It accounts for recently uninstalled or inactive profiles faster and reflects unrounded telemetry directly recorded by Google Omaha updater.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Telematics & Telemetry Deep Dive -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- In-App Telematics -->
      <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-base text-white flex items-center gap-2">
            <span>📊</span> In-App Local Telematics (<code class="text-xs text-emerald-400 font-mono">lib/usage.js</code>)
          </h3>
          <span class="px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Zero-Remote Data</span>
        </div>

        <p class="text-xs text-[var(--muted-foreground,#94a3b8)]">
          Adhan Focus strictly abides by privacy-first engineering: <strong>zero bytes of telemetry leave the user device</strong>. Local events are recorded strictly in <code class="text-slate-300 font-mono">chrome.storage.local</code> to render personal prayer streak & engagement stats in the popup:
        </p>

        <div class="grid grid-cols-2 gap-3 pt-1">
          <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <span class="text-xs text-[var(--muted-foreground,#94a3b8)] block">Event 1</span>
            <span class="text-sm font-bold text-white font-mono">pauses</span>
            <p class="text-[11px] text-[var(--muted-foreground,#94a3b8)] mt-1">Times media was auto-paused across tabs during Adhan.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <span class="text-xs text-[var(--muted-foreground,#94a3b8)] block">Event 2</span>
            <span class="text-sm font-bold text-white font-mono">resumes</span>
            <p class="text-[11px] text-[var(--muted-foreground,#94a3b8)] mt-1">Times media was resumed manually or auto-resumed.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <span class="text-xs text-[var(--muted-foreground,#94a3b8)] block">Event 3</span>
            <span class="text-sm font-bold text-white font-mono">notifications</span>
            <p class="text-[11px] text-[var(--muted-foreground,#94a3b8)] mt-1">Prayer time desktop notifications triggered.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <span class="text-xs text-[var(--muted-foreground,#94a3b8)] block">Event 4</span>
            <span class="text-sm font-bold text-white font-mono">focusUsed</span>
            <p class="text-[11px] text-[var(--muted-foreground,#94a3b8)] mt-1">Full-screen breathing Prayer Focus activations.</p>
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1.5">
          <div class="flex justify-between">
            <span class="text-[var(--muted-foreground,#94a3b8)]">Retention Policy:</span>
            <span class="text-white font-mono">90-day rolling prune (\`prune()\`)</span>
          </div>
          <div class="flex justify-between">
            <span class="text-[var(--muted-foreground,#94a3b8)]">Engagement Signal:</span>
            <span class="text-white font-mono">Trailing 7-day sum (\`recent()\`) & activeDays</span>
          </div>
          <div class="flex justify-between">
            <span class="text-[var(--muted-foreground,#94a3b8)]">Concurrency Protection:</span>
            <span class="text-white font-mono">Serialized Promise chain in \`background.js\`</span>
          </div>
        </div>
      </div>

      <!-- Store-Level Telematics & Architecture -->
      <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-base text-white flex items-center gap-2">
            <span>🛡️</span> Store Infrastructure Telemetry Comparison
          </h3>
          <span class="px-2 py-0.5 text-[10px] font-semibold rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">Browser Pings</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs text-left">
            <thead class="text-[var(--muted-foreground,#94a3b8)] border-b border-slate-800">
              <tr>
                <th class="py-2 font-medium">Store</th>
                <th class="py-2 font-medium">Ping Protocol</th>
                <th class="py-2 font-medium">Cadence</th>
                <th class="py-2 font-medium">User Metric Reported</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60 text-slate-300">
              <tr>
                <td class="py-2.5 font-bold text-white">Chrome</td>
                <td class="py-2.5 font-mono text-[11px] text-blue-400">Google Omaha</td>
                <td class="py-2.5">~5 hours</td>
                <td class="py-2.5">Weekly Active Users & DAU</td>
              </tr>
              <tr>
                <td class="py-2.5 font-bold text-white">Firefox</td>
                <td class="py-2.5 font-mono text-[11px] text-orange-400">AMO VersionCheck</td>
                <td class="py-2.5">~24 hours</td>
                <td class="py-2.5">Average Daily Users (ADU)</td>
              </tr>
              <tr>
                <td class="py-2.5 font-bold text-white">Edge</td>
                <td class="py-2.5 font-mono text-[11px] text-cyan-400">Edge Update</td>
                <td class="py-2.5">Daily</td>
                <td class="py-2.5">Active Install Count</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Engineering / Codebase Stats -->
        <div class="pt-2 border-t border-[var(--border,rgba(255,255,255,0.08))]">
          <span class="text-xs font-bold text-white block mb-2">Codebase & Test Suite Health:</span>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span id="statTests" class="text-base font-bold text-emerald-400">249 / 249</span>
              <span class="text-[10px] text-[var(--muted-foreground,#94a3b8)] block">Passing Tests (15 Suites)</span>
            </div>
            <div class="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span id="statLoc" class="text-base font-bold text-blue-400">13,362</span>
              <span class="text-[10px] text-[var(--muted-foreground,#94a3b8)] block">Lines of Code</span>
            </div>
            <div class="p-2 rounded-lg bg-slate-900/60 border border-slate-800">
              <span id="statTokens" class="text-base font-bold text-purple-400">103.5M</span>
              <span class="text-[10px] text-[var(--muted-foreground,#94a3b8)] block">Tokens (95% AI Build)</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Raw Data Viewer Section -->
    <div class="bg-[var(--card,#131b2e)] border border-[var(--border,rgba(255,255,255,0.08))] rounded-2xl p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h4 class="text-sm font-semibold text-white flex items-center gap-2">
          <span>📦</span> Real-Time JSON Stream (<code class="text-xs text-blue-400 font-mono">GET /api/metrics</code>)
        </h4>
        <button onclick="toggleJsonView()" class="text-xs text-[var(--muted-foreground,#94a3b8)] hover:text-white transition flex items-center gap-1">
          <span id="jsonToggleText">Collapse</span> ▾
        </button>
      </div>

      <div id="jsonContainer" class="transition-all duration-200">
        <pre id="jsonPreview" class="p-4 rounded-xl bg-slate-950 font-mono text-xs text-emerald-400 overflow-x-auto max-h-72 border border-slate-800/80"></pre>
      </div>
    </div>

    <!-- Footer -->
    <footer class="text-center text-xs text-[var(--muted-foreground,#94a3b8)] pt-4 pb-2 border-t border-[var(--border,rgba(255,255,255,0.08))]">
      Running live on <strong class="text-white font-mono">http://localhost:${PORT}</strong> · Triggering background queries via <code class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">/api/refresh</code>.
    </footer>

  </div>

  <script>
    let currentData = ${initialJson};
    let lastRefreshTimestamp = currentData.fetchedAt ? new Date(currentData.fetchedAt).getTime() : Date.now();

    function updateDom(data) {
      if (!data || !data.summary) return;
      currentData = data;
      lastRefreshTimestamp = Date.now();

      // KPIs
      document.getElementById('kpiTotalUsers').textContent = data.summary.activeUsersRange || '15 - 18';
      document.getElementById('kpiChromePublic').textContent = data.platforms.chrome.publicListing.publicUsers ?? 17;
      document.getElementById('kpiChromeDev').textContent = data.platforms.chrome.devConsole.activeUsers ?? 14;
      document.getElementById('kpiFirefoxAdu').textContent = data.platforms.firefox.metrics.averageDailyUsers ?? 1;
      document.getElementById('kpiEdgeInstalls').textContent = data.platforms.edge.metrics.activeInstallCount ?? 0;

      // Details
      document.getElementById('detailChromePublic').textContent = (data.platforms.chrome.publicListing.publicUsers ?? 17) + ' users';
      document.getElementById('detailChromeDev').textContent = (data.platforms.chrome.devConsole.activeUsers ?? 14) + ' active users';
      const cRating = data.platforms.chrome.publicListing.rating ?? 0;
      const cText = data.platforms.chrome.publicListing.ratingText || 'No ratings';
      document.getElementById('detailChromeRating').textContent = cRating > 0 ? ('★ ' + cRating + ' / 5.0 (' + cText + ')') : '0 out of 5 (' + cText + ')';
      document.getElementById('kpiChromeRating').textContent = (cRating > 0 ? ('★ ' + cRating + ' / 5.0 (' + cText + ')') : '0 out of 5 stars (' + cText + ')') + ' · 7-day WAU vs DAU telemetry.';
      document.getElementById('detailChromeVersion').textContent = 'v' + (data.platforms.chrome.publicListing.version || '2.1.0');

      document.getElementById('detailFirefoxAdu').textContent = (data.platforms.firefox.metrics.averageDailyUsers ?? 1) + ' user';
      document.getElementById('detailFirefoxDownloads').textContent = (data.platforms.firefox.metrics.weeklyDownloads ?? 1) + ' download';
      document.getElementById('detailFirefoxRating').textContent = (data.platforms.firefox.metrics.rating ?? 0) + ' (' + (data.platforms.firefox.metrics.ratingCount ?? 0) + ' reviews)';
      document.getElementById('detailFirefoxVersion').textContent = 'v' + (data.platforms.firefox.metrics.version || '2.1.0');

      document.getElementById('detailEdgeInstalls').textContent = (data.platforms.edge.metrics.activeInstallCount ?? 0) + ' installs';
      document.getElementById('detailEdgeRating').textContent = (data.platforms.edge.metrics.rating ?? 0) + ' (' + (data.platforms.edge.metrics.ratingCount ?? 0) + ' reviews)';
      document.getElementById('detailEdgeVersion').textContent = 'v' + (data.platforms.edge.metrics.version || '2.1.0');

      if (data.platforms.opera) {
        if (document.getElementById('detailOperaStatus')) {
          document.getElementById('detailOperaStatus').textContent = data.platforms.opera.metrics.status === 'active' ? 'Live in Store' : 'In Review / Auto-Publish';
        }
        if (document.getElementById('detailOperaVersion')) {
          document.getElementById('detailOperaVersion').textContent = 'v' + (data.platforms.opera.metrics.version || '2.1.0');
        }
      }

      // Version badge
      document.getElementById('headerVersion').textContent = 'v' + (data.manifestVersion || '2.1.0');

      // JSON preview
      document.getElementById('jsonPreview').textContent = JSON.stringify(data, null, 2);

      // Flash pulse effect
      ['cardTotalUsers', 'cardChromeUsers', 'cardFirefoxUsers', 'cardEdgeUsers'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.classList.remove('data-pulse');
          void el.offsetWidth;
          el.classList.add('data-pulse');
        }
      });
    }

    // Refresh function
    async function triggerRefresh() {
      const btn = document.getElementById('refreshBtn');
      const spinner = document.getElementById('refreshSpinner');
      const text = document.getElementById('refreshBtnText');

      btn.disabled = true;
      spinner.classList.add('animate-spin');
      text.textContent = 'Querying Live Stores...';

      try {
        const res = await fetch('/api/refresh', { method: 'POST' });
        const json = await res.json();
        updateDom(json);
        text.textContent = 'Updated Just Now!';
        setTimeout(() => { text.textContent = 'Refresh Real-Time Stats'; }, 2000);
      } catch (err) {
        console.error('Refresh error:', err);
        text.textContent = 'Refresh Failed';
        setTimeout(() => { text.textContent = 'Refresh Real-Time Stats'; }, 2000);
      } finally {
        btn.disabled = false;
        spinner.classList.remove('animate-spin');
      }
    }

    // Seconds ticker
    setInterval(() => {
      const elapsed = Math.round((Date.now() - lastRefreshTimestamp) / 1000);
      const el = document.getElementById('tickerTime');
      if (el) {
        if (elapsed < 5) el.textContent = 'Refreshed just now';
        else if (elapsed < 60) el.textContent = 'Refreshed ' + elapsed + 's ago';
        else el.textContent = 'Refreshed ' + Math.round(elapsed / 60) + 'm ago';
      }
    }, 1000);

    // Auto-refresh interval (every 30 seconds)
    setInterval(() => {
      const toggle = document.getElementById('autoRefreshToggle');
      if (toggle && toggle.checked) {
        triggerRefresh();
      }
    }, 30000);

    // Toggle json container
    function toggleJsonView() {
      const container = document.getElementById('jsonContainer');
      const text = document.getElementById('jsonToggleText');
      if (container.style.display === 'none') {
        container.style.display = 'block';
        text.textContent = 'Collapse';
      } else {
        container.style.display = 'none';
        text.textContent = 'Expand';
      }
    }

    // Copy json to clipboard
    function copyMetricsJson() {
      navigator.clipboard.writeText(JSON.stringify(currentData, null, 2)).then(() => {
        const btnText = document.getElementById('copyBtnText');
        btnText.textContent = 'Copied!';
        setTimeout(() => { btnText.textContent = 'Copy JSON'; }, 2000);
      });
    }

    // Initialize with current data
    if (currentData && currentData.summary) {
      updateDom(currentData);
    }
  </script>
</body>
</html>`;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route: / (Dashboard HTML)
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
    return;
  }

  // Route: /api/metrics (JSON)
  if (url.pathname === '/api/metrics') {
    if (!cachedMetrics || url.searchParams.get('refresh') === 'true') {
      await refreshMetrics();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cachedMetrics, null, 2));
    return;
  }

  // Route: /api/refresh (Trigger live query)
  if (url.pathname === '/api/refresh') {
    const data = await refreshMetrics();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`🚀 ADHAN FOCUS REAL-TIME DASHBOARD SERVER ACTIVE`);
  console.log(`================================================================`);
  console.log(`👉 Local URL:     http://localhost:${PORT}`);
  console.log(`📡 API Stream:    http://localhost:${PORT}/api/metrics`);
  console.log(`🔄 Refresh Hook:  http://localhost:${PORT}/api/refresh`);
  console.log(`================================================================`);
});
