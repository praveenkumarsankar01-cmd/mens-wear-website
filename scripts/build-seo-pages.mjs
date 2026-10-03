#!/usr/bin/env node
// Builds the static, crawlable pages Google indexes:
//   /products/<slug>/   one page per product (Product + BreadcrumbList + Organization schema)
//   /category/<slug>/   one page per category (ItemList schema)
//   /shop/              every product, grouped by category
//   /about/, /shipping-policy/, /payment-policy/, /return-policy/, /privacy-policy/, /terms/
//   /sitemap.xml        every page above + the home page, with image entries
// and refreshes the product-slug map inside index.html so the store's product cards
// link to these pages.
//
// Product data comes from the live store (Firestore settings/products — the same list
// the admin panel edits). The last fetched copy is saved to data/products.json and is
// used when the network is unavailable.
//
// Usage:
//   node scripts/build-seo-pages.mjs                 fetch live products (falls back to snapshot)
//   node scripts/build-seo-pages.mjs --offline       use data/products.json only
//   node scripts/build-seo-pages.mjs --require-live  fail if the live fetch fails (CI)
// Requires Node 18+. No dependencies.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://vynox-menswear.vercel.app';
const FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/vynox-d8699/databases/(default)/documents/settings/products'
    + '?key=AIzaSyCbe7VF8AVO_MMRthXc4A7N_h2aTYujkaE'; // public web API key (same one index.html ships)
const GA_ID = 'G-4SCD2MBTPE';
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const TODAY = new Date().toISOString().slice(0, 10);
const args = new Set(process.argv.slice(2));

const CATEGORIES = {
    formal: {
        slug: 'formal-wear', label: 'Formal Wear', spa: 'Formal',
        h1: "Men's Formal Wear",
        title: "Men's Formal Wear Online – Suits, Shirts & Blazers | Vynox",
        lead: 'suits, formal shirts, blazers and trousers',
        intro: [
            'Dress for the boardroom, the interview and every wedding reception in between. Our formal edit brings together tailored suits, crisp formal shirts, structured blazers and sharp trousers from brands like Raymond, Van Heusen, Louis Philippe and Allen Solly.',
            'Pair a formal shirt with slim-fit trousers for the office, or step up to a tailored suit or classic black tuxedo for evening events. Every piece ships free on prepaid orders, with Cash on Delivery available across India.',
        ],
    },
    casual: {
        slug: 'casual-wear', label: 'Casual Wear', spa: 'Casual',
        h1: "Men's Casual Wear",
        title: "Men's Casual Wear Online – Shirts, Tees, Jeans & Chinos | Vynox",
        lead: 'casual shirts, T-shirts, jeans, chinos and joggers',
        intro: [
            'Everyday clothes that still look put together. Shop relaxed casual shirts, graphic and plain T-shirts, polo tees, slim-fit jeans, chinos, cargo pants and joggers from Levi\'s, Wrangler, Puma, H&M and Roadster — made for weekends, college and travel.',
            'Build easy outfits — a linen shirt with navy chinos, or a white tee with black jeans — and get free shipping on prepaid orders with a 3-day easy replacement.',
        ],
    },
    winter: {
        slug: 'winter-wear', label: 'Winter Collection', spa: 'Winter',
        h1: "Men's Winter Wear",
        title: "Men's Winter Wear Online – Jackets, Hoodies & Sweaters | Vynox",
        lead: 'jackets, hoodies, sweaters and sweatshirts',
        intro: [
            'Stay warm without losing your style. Our winter collection covers puffer, bomber, denim, quilted and leather biker jackets, plus hoodies, turtle neck sweaters and zip-up sweatshirts from Jack & Jones, Zara, Levi\'s, H&M and Puma.',
            'Layer a turtle neck under a bomber for chilly evenings or pick a hooded jacket for travel. Free shipping on prepaid orders, Cash on Delivery available, and 3-day easy replacement.',
        ],
    },
    ethnic: {
        slug: 'ethnic-wear', label: 'Ethnic Wear', spa: 'Ethnic',
        h1: "Men's Ethnic Wear",
        title: "Men's Ethnic Wear Online – Kurtas, Sherwanis & Bandhgalas | Vynox",
        lead: 'kurtas, sherwanis, Jodhpuri bandhgalas and ethnic suits',
        intro: [
            'Celebrate festivals, weddings and family functions in style. Choose from cotton and silk-blend kurtas, Bandhani prints, regal sherwanis, Jodhpuri bandhgala suits and designer ethnic sets from Manyavar and Fabindia.',
            'Team a sky-blue cotton kurta with white pyjamas for a day function, or go all out with a gold sherwani for the wedding. Free shipping on prepaid orders across India.',
        ],
    },
};
const CATEGORY_ORDER = ['formal', 'casual', 'winter', 'ethnic'];

const POLICIES = [
    { id: 'about', path: '/about/', label: 'About Us', title: 'About Vynox – Premium Menswear Brand from India' },
    { id: 'shipping', path: '/shipping-policy/', label: 'Shipping Policy', title: 'Shipping & Delivery Policy | Vynox' },
    { id: 'payment', path: '/payment-policy/', label: 'Payment Policy', title: 'Payment Policy – UPI, Cards & Cash on Delivery | Vynox' },
    { id: 'return', path: '/return-policy/', label: 'Return & Refund Policy', title: 'Return & Refund Policy | Vynox' },
    { id: 'privacy', path: '/privacy-policy/', label: 'Privacy Policy', title: 'Privacy Policy | Vynox' },
    { id: 'terms', path: '/terms/', label: 'Terms of Service', title: 'Terms of Service | Vynox' },
];

// ───────────────────────── helpers ─────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inr = n => '₹' + Number(n).toLocaleString('en-IN');
const jsonLd = obj => JSON.stringify(obj, null, 1).replace(/</g, '\\u003c');
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

function slugify(s) {
    return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
}

// Unsplash and Pexels both resize with ?w=
function resized(url, w) {
    if (!/images\.(unsplash|pexels)\.com/.test(url)) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('w', String(w));
        return u.toString();
    } catch { return url; }
}

// Accept http(s) image URLs only; fix protocol-relative ones ("//host/…")
function imageUrl(s) {
    s = String(s || '').trim();
    if (s.startsWith('//')) s = 'https:' + s;
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch { return ''; }
}

// JSON for inline <script> blocks: "<" escaped so data can never close the tag
const inlineJson = o => JSON.stringify(o).replace(/</g, '\\u003c');

// Stable key order, so the saved snapshot only changes when the data does
const canonical = v => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;

function truncate(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s–-]+$/, '') + '…';
}

function paragraphs(desc) {
    return String(desc).replace(/\r/g, '').split(/\n\s*\n/)
        .map(p => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function categoryKey(c, name) {
    c = String(c || '').toLowerCase().trim();
    if (c === 'kurta' || c === 'kurtas') return 'ethnic';
    if (CATEGORIES[c]) return c;
    // No (or an unknown) category set in the admin panel — infer one from the product
    // name. Keep in step with storeCategory() in index.html.
    const n = String(name || '').toLowerCase();
    if (/\b(kurtas?|sherwanis?|bandhgala|jodhpuri|ethnic|nehru)\b/.test(n)) return 'ethnic';
    if (/\b(jackets?|hoodies?|sweaters?|sweatshirts?|coats?|thermals?|puffer)\b/.test(n)) return 'winter';
    if (/\b(t-shirts?|tees?|jeans|chinos?|joggers?|cargo|polos?|shorts)\b/.test(n)) return 'casual';
    return 'formal';
}

// ───────────────────────── data ─────────────────────────
function fromFirestoreValue(v) {
    const [type, x] = Object.entries(v)[0];
    if (type === 'mapValue') return Object.fromEntries(Object.entries(x.fields || {}).map(([k, vv]) => [k, fromFirestoreValue(vv)]));
    if (type === 'arrayValue') return (x.values || []).map(fromFirestoreValue);
    if (type === 'integerValue' || type === 'doubleValue') return Number(x);
    if (type === 'nullValue') return null;
    return x;
}

async function loadProducts() {
    const snapshot = join(ROOT, 'data', 'products.json');
    if (!args.has('--offline')) {
        try {
            const res = await fetch(FIRESTORE_URL);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const doc = await res.json();
            const list = fromFirestoreValue(doc.fields.list);
            if (!Array.isArray(list) || !list.length) throw new Error('empty product list');
            mkdirSync(dirname(snapshot), { recursive: true });
            writeFileSync(snapshot, JSON.stringify(canonical(list), null, 2) + '\n');
            console.log(`Fetched ${list.length} live products from Firestore.`);
            return list;
        } catch (e) {
            if (args.has('--require-live')) { console.error('Live product fetch failed:', e.message); process.exit(1); }
            console.warn(`Live product fetch failed (${e.message}); using data/products.json.`);
        }
    }
    return JSON.parse(readFileSync(snapshot, 'utf8'));
}

function normalise(raw) {
    const price = Number(raw.price) || 0;
    const mrp = Number(raw.originalPrice) || 0;
    const images = [...new Set([raw.image, ...(Array.isArray(raw.images) ? raw.images : [])].map(imageUrl).filter(Boolean))];
    const image = images[0] || '';
    const p = {
        id: String(raw.id),
        name: String(raw.name || '').trim(),
        brand: String(raw.brand || 'Vynox').trim(),
        description: String(raw.description || '').trim(),
        price,
        mrp: mrp > price ? mrp : null,
        discount: mrp > price ? Math.round((1 - price / mrp) * 100) : 0,
        image, images,
        cat: categoryKey(raw.category, raw.name),
        stock: raw.stock === undefined || raw.stock === null ? null : Number(raw.stock),
        sku: String(raw.sku || ('VYN-' + raw.id)),
    };
    p.slug = SLUGS[p.id] || `${slugify(p.name) || 'product'}-${slugify(p.id) || 'item'}`;
    p.path = `/products/${p.slug}/`;
    p.url = SITE + p.path;
    p.inStock = p.stock === null || p.stock > 0;
    return p;
}

// ───────────────────────── content reused from index.html ─────────────────────────
const INDEX = readFileSync(join(ROOT, 'index.html'), 'utf8');

function extractDiv(html, openTag) {
    const start = html.indexOf(openTag);
    if (start < 0) return null;
    const re = /<div\b|<\/div>/g;
    re.lastIndex = start;
    let depth = 0, m;
    while ((m = re.exec(html))) {
        depth += m[0] === '</div>' ? -1 : 1;
        if (depth === 0) return html.slice(start + openTag.length, m.index);
    }
    return null;
}

function policyContent(id) {
    let inner = extractDiv(INDEX, `<div class="policy-page" id="page-${id}">`);
    if (inner === null) throw new Error('Policy section not found in index.html: ' + id);
    inner = inner
        .replace(/<button class="policy-back-btn"[\s\S]*?<\/button>/g, '')
        .replace(/<button onclick="resetCookieConsent\(\)"[^>]*>([\s\S]*?)<\/button>/g,
            '<a class="btn secondary" href="/?cookies=1">$1</a>')
        .replace(/<h2>/, '<h1>').replace(/<\/h2>/, '</h1>')
        .replace(/<(\/?)h3>/g, '<$1h2>')
        .replace(/<(\/?)h4>/g, '<$1h3>');
    const subtitle = (inner.match(/<p class="policy-subtitle">([\s\S]*?)<\/p>/) || [])[1] || '';
    return { html: inner.trim(), subtitle: subtitle.replace(/<[^>]+>/g, '').trim() };
}

const SIZE_GUIDE = (INDEX.match(/<table class="size-guide-table">[\s\S]*?<\/table>/) || [''])[0];

// ───────────────────────── shared page parts ─────────────────────────
const ORG = {
    '@type': 'Organization', '@id': SITE + '/#organization',
    name: 'Vynox', alternateName: 'Vynox Menswear', url: SITE + '/',
    email: 'info@vynox.com', telephone: '+91-90925-43740',
    contactPoint: { '@type': 'ContactPoint', telephone: '+91-90925-43740', email: 'info@vynox.com', contactType: 'customer service', areaServed: 'IN', availableLanguage: ['English', 'Hindi'] },
    sameAs: ['https://www.instagram.com/vynox.menswear/', 'https://www.facebook.com/vynoxmenswear/'],
};
const WEBSITE = { '@type': 'WebSite', '@id': SITE + '/#website', name: 'Vynox', url: SITE + '/', publisher: { '@id': ORG['@id'] }, inLanguage: 'en-IN' };

function breadcrumb(items) {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: SITE + it.path })),
    };
}

function breadcrumbNav(items) {
    return `<nav class="breadcrumb wrap" aria-label="Breadcrumb"><ol>${items.map((it, i) => i === items.length - 1
        ? `<li aria-current="page">${esc(it.name)}</li>`
        : `<li><a href="${it.path}">${esc(it.name)}</a></li>`).join('')}</ol></nav>`;
}

function head({ title, description, path, image, type = 'website', schema, extraMeta = '', preconnect = [] }) {
    const url = SITE + path;
    return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="Vynox">
<meta property="og:locale" content="en_IN">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
${image ? `<meta property="og:image" content="${esc(image)}">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">\n` : ''}${extraMeta}<meta name="theme-color" content="#ffffff">
${[...new Set(preconnect)].map(o => `<link rel="preconnect" href="${o}">`).join('\n')}
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">
${jsonLd({ '@context': 'https://schema.org', '@graph': [ORG, WEBSITE, ...schema] })}
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
(function(){
  var c = null; try { c = localStorage.getItem('vyn_cookie_consent'); } catch (e) {}
  var g = c === 'accepted' ? 'granted' : 'denied';
  gtag('consent', 'default', { analytics_storage: g, ad_storage: g, ad_user_data: g, ad_personalization: g });
})();
gtag('js', new Date());
gtag('config', '${GA_ID}');
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="topbar">🚚 Free shipping on prepaid orders &nbsp;·&nbsp; ↩️ 3-day easy replacement &nbsp;·&nbsp; 💵 Cash on Delivery available</div>
<header class="site-header">
 <div class="wrap">
  <a class="logo" href="/">Vynox</a>
  <nav class="site-nav" aria-label="Main">
${CATEGORY_ORDER.map(k => `   <a href="/category/${CATEGORIES[k].slug}/"${path === `/category/${CATEGORIES[k].slug}/` ? ' aria-current="page"' : ''}>${CATEGORIES[k].label}</a>`).join('\n')}
   <a href="/shop/"${path === '/shop/' ? ' aria-current="page"' : ''}>All Products</a>
  </nav>
  <a class="header-cta" href="/?cart=1">🛒 Cart</a>
 </div>
</header>
`;
}

function footer(extraScript = '') {
    return `<footer class="site-footer">
 <div class="wrap">
  <div class="footer-cols">
   <div>
    <h2>Vynox</h2>
    <p>Premium menswear for the modern gentleman — formal, casual, winter and ethnic wear, delivered across India.</p>
   </div>
   <div>
    <h2>Shop</h2>
    <ul>
${CATEGORY_ORDER.map(k => `     <li><a href="/category/${CATEGORIES[k].slug}/">${CATEGORIES[k].label}</a></li>`).join('\n')}
     <li><a href="/shop/">All Products</a></li>
    </ul>
   </div>
   <div>
    <h2>Help</h2>
    <ul>
     <li><a href="/shipping-policy/">Shipping Policy</a></li>
     <li><a href="/return-policy/">Return &amp; Refund Policy</a></li>
     <li><a href="/payment-policy/">Payment Policy</a></li>
     <li><a href="/?track=1">Track Order</a></li>
    </ul>
   </div>
   <div>
    <h2>Company</h2>
    <ul>
     <li><a href="/about/">About Us</a></li>
     <li><a href="/privacy-policy/">Privacy Policy</a></li>
     <li><a href="/terms/">Terms of Service</a></li>
     <li><a href="mailto:info@vynox.com">info@vynox.com</a></li>
     <li><a href="tel:+919092543740">+91 90925 43740</a></li>
     <li><a href="https://www.instagram.com/vynox.menswear/" rel="noopener">Instagram</a></li>
    </ul>
   </div>
  </div>
  <p class="footer-bottom">© ${new Date().getFullYear()} Vynox. All rights reserved. Made in India.</p>
 </div>
</footer>
${extraScript}</body>
</html>
`;
}

function card(p, { eager = false } = {}) {
    return `<li class="card"><a href="${p.path}">
 <div class="card-img">${p.discount > 0 ? `<span class="card-badge">${p.discount}% OFF</span>` : ''}<img src="${esc(resized(p.image, 500))}" srcset="${esc(resized(p.image, 360))} 360w, ${esc(resized(p.image, 500))} 500w, ${esc(resized(p.image, 800))} 800w" sizes="(max-width: 720px) 50vw, 25vw" alt="${esc(p.name)} by ${esc(p.brand)}" width="400" height="500" loading="${eager ? 'eager' : 'lazy'}"></div>
 <div class="card-brand">${esc(p.brand)}</div>
 <div class="card-name">${esc(p.name)}</div>
 <div class="card-price">${inr(p.price)}${p.mrp ? `<s>${inr(p.mrp)}</s>` : ''}</div>
</a></li>`;
}

const imageOrigins = list => list.map(u => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean);

// ───────────────────────── page builders ─────────────────────────
function productPage(p, related) {
    const cat = CATEGORIES[p.cat];
    const crumbs = [{ name: 'Home', path: '/' }, { name: cat.label, path: `/category/${cat.slug}/` }, { name: p.name, path: p.path }];
    let title = `Buy ${p.name} Online – ${inr(p.price)} | Vynox`;
    if (title.length > 65) title = `${p.name} – ${inr(p.price)} | Vynox`;
    const paras = paragraphs(p.description);
    const lead = `Buy ${p.name} by ${p.brand} at ${inr(p.price)}${p.mrp ? ` (${p.discount}% off MRP ${inr(p.mrp)})` : ''}.`;
    const perks = ' Free shipping on prepaid orders, COD available, 3-day easy replacement.';
    let firstSentence = (paras.join(' ').match(/^.*?[.!?](\s|$)/) || [paras[0] || ''])[0].trim();
    if (firstSentence && !/[.!?]$/.test(firstSentence)) firstSentence += '.';
    let description = lead + perks;
    if ((lead + ' ' + firstSentence + perks).length <= 160 && firstSentence) description = lead + ' ' + firstSentence + perks;
    description = truncate(description, 160);

    const priceValidUntil = `${new Date().getFullYear() + 1}-12-31`;
    const product = {
        '@type': 'Product', '@id': p.url + '#product',
        name: p.name,
        description: paras.join(' ') || p.name,
        image: p.images.map(u => resized(u, 1200)),
        sku: p.sku,
        brand: { '@type': 'Brand', name: p.brand },
        category: `Men's ${cat.label}`,
        audience: { '@type': 'PeopleAudience', suggestedGender: 'male' },
        url: p.url,
        offers: {
            '@type': 'Offer',
            url: p.url,
            priceCurrency: 'INR',
            price: String(p.price),
            priceValidUntil,
            availability: p.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            itemCondition: 'https://schema.org/NewCondition',
            seller: { '@id': ORG['@id'] },
            shippingDetails: {
                '@type': 'OfferShippingDetails',
                shippingRate: { '@type': 'MonetaryAmount', value: 0, currency: 'INR' },
                shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' },
                deliveryTime: {
                    '@type': 'ShippingDeliveryTime',
                    handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 2, unitCode: 'DAY' },
                    transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 7, unitCode: 'DAY' },
                },
            },
            hasMerchantReturnPolicy: {
                '@type': 'MerchantReturnPolicy',
                applicableCountry: 'IN',
                returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
                merchantReturnDays: 3,
                returnPolicyCountry: 'IN',
                returnMethod: 'https://schema.org/ReturnByMail',
                itemDefectReturnFees: 'https://schema.org/FreeReturn',
                merchantReturnLink: SITE + '/return-policy/',
            },
        },
    };

    const stockLine = !p.inStock
        ? '<p class="stock out">Currently out of stock</p>'
        : (p.stock !== null && p.stock <= 5 ? `<p class="stock low">🔥 Only ${p.stock} left in stock</p>` : '<p class="stock in">✓ In stock — ready to ship</p>');
    const mainImg = p.images[0];
    const thumbs = p.images.length > 1 ? `<div class="thumbs" role="group" aria-label="Product images">
${p.images.map((u, i) => `  <button type="button" data-src="${esc(resized(u, 900))}" aria-pressed="${i === 0}" aria-label="Show image ${i + 1}"><img src="${esc(resized(u, 160))}" alt="" width="72" height="90" loading="lazy"></button>`).join('\n')}
 </div>` : '';
    const buy = `/?product=${encodeURIComponent(p.id)}`;
    const ga = { currency: 'INR', value: p.price, items: [{ item_id: p.id, item_name: p.name, item_brand: p.brand, item_category: cat.label, price: p.price }] };

    return head({
        title, description, path: p.path, image: resized(mainImg, 1200), type: 'product',
        extraMeta: `<meta property="product:price:amount" content="${p.price}">\n<meta property="product:price:currency" content="INR">\n`,
        preconnect: imageOrigins([mainImg]),
        schema: [breadcrumb(crumbs), product],
    }) + `${breadcrumbNav(crumbs)}
<main id="main" class="wrap">
 <article class="product">
  <div class="gallery">
   <div class="gallery-main"><img id="mainImage" src="${esc(resized(mainImg, 900))}" srcset="${esc(resized(mainImg, 600))} 600w, ${esc(resized(mainImg, 900))} 900w, ${esc(resized(mainImg, 1200))} 1200w" sizes="(max-width: 860px) 100vw, 50vw" alt="${esc(p.name)} by ${esc(p.brand)}" width="800" height="1000" fetchpriority="high"></div>
   ${thumbs}
  </div>
  <div class="info">
   <p class="brand">${esc(p.brand)}</p>
   <h1>${esc(p.name)}</h1>
   <div class="price"><span class="now">${inr(p.price)}</span>${p.mrp ? `<s>MRP ${inr(p.mrp)}</s><span class="off">${p.discount}% off</span>` : ''}</div>
   <p class="tax">Inclusive of all taxes${p.mrp ? ` · You save ${inr(p.mrp - p.price)}` : ''}</p>
   ${stockLine}
${p.inStock ? `   <div class="sizes-label">Select size</div>
   <div class="sizes">${SIZES.map(s => `<a href="${buy}&amp;size=${s}" rel="nofollow" aria-label="Buy in size ${s}">${s}</a>`).join('')}</div>
   <div class="cta"><a class="btn primary" href="${buy}" rel="nofollow">Buy Now</a><a class="btn secondary" href="${buy}" rel="nofollow">Add to Cart</a></div>` : `   <div class="cta"><a class="btn secondary" href="/category/${cat.slug}/">See similar ${esc(cat.label.toLowerCase())}</a></div>`}
   <ul class="perks">
    <li>🚚 Free shipping on prepaid orders across India</li>
    <li>💵 Cash on Delivery available (₹49 COD fee)</li>
    <li>↩️ 3-day easy replacement for damaged or wrong items</li>
    <li>🔒 Secure payment by UPI, cards and net banking (Razorpay)</li>
   </ul>
   <section class="section-block">
    <h2>Product description</h2>
${(paras.length ? paras : [p.name]).map(t => `    <p>${esc(t)}</p>`).join('\n')}
   </section>
   <section class="section-block">
    <h2>Product details</h2>
    <table class="details-table">
     <tr><th scope="row">Brand</th><td>${esc(p.brand)}</td></tr>
     <tr><th scope="row">Category</th><td><a href="/category/${cat.slug}/">Men's ${esc(cat.label)}</a></td></tr>
     <tr><th scope="row">Available sizes</th><td>${SIZES.join(', ')}</td></tr>
     <tr><th scope="row">Price</th><td>${inr(p.price)}${p.mrp ? ` (MRP ${inr(p.mrp)})` : ''}</td></tr>
     <tr><th scope="row">SKU</th><td>${esc(p.sku)}</td></tr>
    </table>
   </section>
${SIZE_GUIDE ? `   <section class="section-block">
    <h2>Size guide</h2>
    <p class="muted">All measurements in inches. When in doubt, size up.</p>
    ${SIZE_GUIDE}
   </section>
` : ''}   <section class="section-block">
    <h2>Delivery &amp; returns</h2>
    <p>Orders are dispatched within 1–2 business days and delivered in 4–7 business days (3–5 days in metro cities). Prepaid orders ship free; Cash on Delivery has a ₹49 fee.</p>
    <p>Received a damaged, defective or wrong item? Request a replacement within 3 days of delivery. Read our <a href="/shipping-policy/">shipping policy</a> and <a href="/return-policy/">return &amp; refund policy</a>.</p>
   </section>
  </div>
 </article>
${related.length ? ` <section class="related">
  <h2>You may also like</h2>
  <ul class="grid">
${related.map(r => card(r)).join('\n')}
  </ul>
 </section>
` : ''}</main>
` + footer(`<script>
document.querySelectorAll('.thumbs button').forEach(function (b) {
  b.addEventListener('click', function () {
    var img = document.getElementById('mainImage');
    img.removeAttribute('srcset'); img.src = b.getAttribute('data-src');
    document.querySelectorAll('.thumbs button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });
});
gtag('event', 'view_item', ${inlineJson(ga)});
</script>
`);
}

function itemList(items, name) {
    return { '@type': 'ItemList', name, numberOfItems: items.length, itemListElement: items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: p.url, name: p.name })) };
}

function categoryPage(key, items) {
    const cat = CATEGORIES[key];
    const path = `/category/${cat.slug}/`;
    const crumbs = [{ name: 'Home', path: '/' }, { name: cat.label, path }];
    const minPrice = Math.min(...items.map(p => p.price));
    const description = truncate(`Shop ${items.length} men's ${cat.label.toLowerCase()} styles at Vynox – ${cat.lead} from ${inr(minPrice)}. Free shipping on prepaid orders, COD & 3-day replacement.`, 160);
    return head({
        title: cat.title, description, path, image: resized(items[0].image, 1200),
        preconnect: imageOrigins(items.slice(0, 4).map(p => p.image)),
        schema: [breadcrumb(crumbs), { '@type': 'CollectionPage', '@id': SITE + path, name: cat.h1, url: SITE + path, isPartOf: { '@id': WEBSITE['@id'] } }, itemList(items, cat.h1)],
    }) + `${breadcrumbNav(crumbs)}
<main id="main" class="wrap">
 <div class="page-head">
  <h1>${esc(cat.h1)}</h1>
  <p>${items.length} styles · ${esc(cat.lead)} from ${inr(minPrice)}</p>
  <nav class="chips" aria-label="Categories">${CATEGORY_ORDER.map(k => `<a href="/category/${CATEGORIES[k].slug}/"${k === key ? ' aria-current="page"' : ''}>${CATEGORIES[k].label}</a>`).join('')}<a href="/shop/">All Products</a></nav>
 </div>
 <ul class="grid">
${items.map((p, i) => card(p, { eager: i < 4 })).join('\n')}
 </ul>
 <section class="intro-text">
  <h2>Shop ${esc(cat.h1.replace("Men's", "men's"))} online at Vynox</h2>
${cat.intro.map(t => `  <p>${esc(t)}</p>`).join('\n')}
 </section>
</main>
` + footer();
}

function shopPage(byCat, all) {
    const path = '/shop/';
    const crumbs = [{ name: 'Home', path: '/' }, { name: 'All Products', path }];
    const minPrice = Math.min(...all.map(p => p.price));
    const description = truncate(`Shop all ${all.length} men's clothing styles at Vynox – formal, casual, winter and ethnic wear from ${inr(minPrice)}. Free shipping on prepaid orders across India.`, 160);
    return head({
        title: "Shop All Men's Clothing Online India | Vynox", description, path, image: resized(all[0].image, 1200),
        preconnect: imageOrigins(all.slice(0, 4).map(p => p.image)),
        schema: [breadcrumb(crumbs), { '@type': 'CollectionPage', '@id': SITE + path, name: "All Men's Clothing", url: SITE + path, isPartOf: { '@id': WEBSITE['@id'] } }, itemList(all, "All Men's Clothing")],
    }) + `${breadcrumbNav(crumbs)}
<main id="main" class="wrap">
 <div class="page-head">
  <h1>Shop All Men's Clothing</h1>
  <p>${all.length} styles across formal, casual, winter and ethnic wear — free shipping on prepaid orders, Cash on Delivery available.</p>
 </div>
${CATEGORY_ORDER.filter(k => byCat[k].length).map((k, ci) => ` <section class="shop-section">
  <h2>${esc(CATEGORIES[k].h1)}</h2>
  <a class="see-all" href="/category/${CATEGORIES[k].slug}/">View all ${byCat[k].length} ${esc(CATEGORIES[k].label.toLowerCase())} →</a>
  <ul class="grid">
${byCat[k].map((p, i) => card(p, { eager: ci === 0 && i < 4 })).join('\n')}
  </ul>
 </section>`).join('\n')}
</main>
` + footer();
}

function policyPage(pol) {
    const { html, subtitle } = policyContent(pol.id);
    const crumbs = [{ name: 'Home', path: '/' }, { name: pol.label, path: pol.path }];
    const description = truncate(`${subtitle} ${pol.id === 'about' ? 'Formal, casual, winter and ethnic menswear delivered across India.' : 'Read the Vynox ' + pol.label.toLowerCase() + '.'}`.trim(), 160);
    return head({ title: pol.title, description, path: pol.path, schema: [breadcrumb(crumbs), { '@type': pol.id === 'about' ? 'AboutPage' : 'WebPage', '@id': SITE + pol.path, name: pol.label, url: SITE + pol.path, isPartOf: { '@id': WEBSITE['@id'] } }] })
        + `${breadcrumbNav(crumbs)}
<main id="main" class="wrap">
 <div class="policy-page">
${html}
 </div>
</main>
` + footer();
}

// ───────────────────────── write everything ─────────────────────────
const manifestPath = join(ROOT, 'data', 'pages-manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
// Product id → URL slug, fixed the first time a product is seen, so renaming a product
// in Admin never changes (and 404s) a URL Google has already indexed.
const slugsPath = join(ROOT, 'data', 'product-slugs.json');
const SLUGS = existsSync(slugsPath) ? JSON.parse(readFileSync(slugsPath, 'utf8')) : {};
const pages = []; // { path, images? }

function writePage(path, html, images = []) {
    const file = join(ROOT, path, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    trackPage(path, html, images);
}

// lastmod only moves when a page's content actually changes
function trackPage(path, content, images = []) {
    const hash = sha(content);
    const prev = manifest[path];
    manifest[path] = { hash, lastmod: prev && prev.hash === hash ? prev.lastmod : TODAY };
    pages.push({ path, images });
}

const raw = await loadProducts();
const products = [];
for (const r of raw) {
    const p = normalise(r);
    if (!p.name || !p.image) { console.warn(`Skipping product ${p.id}: missing name or image.`); continue; }
    if (p.price <= 1) { console.warn(`Skipping "${p.name}" (id ${p.id}): price ${inr(p.price)} looks like a test item.`); continue; }
    products.push(p);
}
if (!products.length) { console.error('No usable products — refusing to rebuild (existing pages left untouched).'); process.exit(1); }
for (const p of products) SLUGS[p.id] = p.slug;
const byCat = Object.fromEntries(CATEGORY_ORDER.map(k => [k, products.filter(p => p.cat === k)]));

for (const p of products) {
    const same = byCat[p.cat].filter(x => x.id !== p.id);
    const others = products.filter(x => x.cat !== p.cat);
    const idx = same.findIndex(x => Number(x.id) > Number(p.id));
    const rotated = idx > 0 ? [...same.slice(idx), ...same.slice(0, idx)] : same; // neighbours first, so related links spread across the catalogue
    writePage(p.path, productPage(p, [...rotated, ...others].slice(0, 4)), p.images);
}
for (const k of CATEGORY_ORDER) {
    if (byCat[k].length) writePage(`/category/${CATEGORIES[k].slug}/`, categoryPage(k, byCat[k]));
    else writeEmptyCategoryPage(k);
}
writePage('/shop/', shopPage(byCat, products));
for (const pol of POLICIES) writePage(pol.path, policyPage(pol));

function writeEmptyCategoryPage(key) {
    const cat = CATEGORIES[key];
    const path = `/category/${cat.slug}/`;
    const html = head({
        title: cat.title, description: `New ${cat.label.toLowerCase()} arriving soon at Vynox. Browse all men's clothing in the meantime.`, path,
        schema: [breadcrumb([{ name: 'Home', path: '/' }, { name: cat.label, path }])],
    }).replace('<meta name="robots" content="index, follow, max-image-preview:large">', '<meta name="robots" content="noindex, follow">')
        + `<main id="main" class="wrap"><div class="page-head"><h1>${esc(cat.h1)}</h1><p>New styles are arriving soon. Meanwhile, <a href="/shop/">browse all products</a>.</p></div></main>\n` + footer();
    const file = join(ROOT, path, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    delete manifest[path];
    console.warn(`Category "${cat.label}" has no products — wrote a noindex placeholder and left it out of the sitemap.`);
}

// Remove pages for products that no longer exist in the store
const productDir = join(ROOT, 'products');
const live = new Set(products.map(p => p.slug));
for (const d of existsSync(productDir) ? readdirSync(productDir) : []) {
    if (!live.has(d)) { rmSync(join(productDir, d), { recursive: true, force: true }); delete manifest[`/products/${d}/`]; console.log('Removed stale page /products/' + d + '/'); }
}

// Product links inside the store (index.html) — only for products that have a page
const slugMap = Object.fromEntries(products.map(p => [p.id, p.slug]));
const START = '/* SEO-SLUGS:START */', END = '/* SEO-SLUGS:END */';
let index = INDEX;
if (index.includes(START) && index.includes(END)) {
    index = index.slice(0, index.indexOf(START) + START.length) + inlineJson(slugMap) + index.slice(index.indexOf(END));
    if (index !== INDEX) writeFileSync(join(ROOT, 'index.html'), index);
} else {
    console.warn('SEO-SLUGS markers not found in index.html — store product cards will not link to product pages.');
}
// Built-in product list in index.html (shown until Firestore responds) mirrors the live
// catalogue exactly as the store maps it (see mapAdminProduct in index.html).
const P_START = '    // PRODUCTS:START', P_END = '    // PRODUCTS:END';
if (index.includes(P_START) && index.includes(P_END)) {
    const startLineEnd = index.indexOf('\n', index.indexOf('\n', index.indexOf(P_START)) + 1) + 1; // keep the two comment lines
    const entries = raw.map(r => {
        const price = Number(r.price) || 0, mrp = Number(r.originalPrice) || null;
        const c = categoryKey(r.category, r.name);
        return {
            id: String(r.id), name: r.name || '', brand: r.brand || 'Vynox',
            description: String(r.description || '').replace(/\s+/g, ' ').trim(),
            price, originalPrice: mrp, discount: mrp ? Math.round((1 - price / mrp) * 100) : 0,
            image: r.image || '', images: Array.isArray(r.images) && r.images.length ? r.images : [r.image || ''],
            category: c.charAt(0).toUpperCase() + c.slice(1),
            stock: Number(r.stock) || 0,
        };
    });
    const block = entries.map(e => '    ' + JSON.stringify(e).replace(/</g, '\\u003c') + ',').join('\n') + '\n';
    const updated = index.slice(0, startLineEnd) + block + index.slice(index.indexOf(P_END));
    if (updated !== index) { index = updated; writeFileSync(join(ROOT, 'index.html'), index); }
} else {
    console.warn('PRODUCTS markers not found in index.html — built-in product list not updated.');
}
// Home page Store schema: keep the price range in step with the catalogue
{
    const prices = products.map(p => p.price);
    const range = `"priceRange": "${inr(Math.min(...prices))} - ${inr(Math.max(...prices))}"`.replace(/,/g, '');
    const updated = index.replace(/"priceRange": "[^"]*"/, range);
    if (updated !== index) { index = updated; writeFileSync(join(ROOT, 'index.html'), index); }
}
trackPage('/', index);

// Sitemap
const priority = path => path === '/' ? '1.0' : path === '/shop/' || path.startsWith('/category/') ? '0.9' : path.startsWith('/products/') ? '0.8' : '0.4';
const sorted = pages.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : priority(b.path) - priority(a.path) || a.path.localeCompare(b.path)));
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${sorted.map(pg => `  <url>
    <loc>${SITE}${pg.path}</loc>
    <lastmod>${manifest[pg.path].lastmod}</lastmod>
    <priority>${priority(pg.path)}</priority>
${pg.images.map(u => `    <image:image><image:loc>${esc(resized(u, 1200))}</image:loc></image:image>\n`).join('')}  </url>`).join('\n')}
</urlset>
`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);
const sortedManifest = Object.fromEntries(Object.keys(manifest).sort().map(k => [k, manifest[k]]));
writeFileSync(manifestPath, JSON.stringify(sortedManifest, null, 2) + '\n');
writeFileSync(slugsPath, JSON.stringify(canonical(SLUGS), null, 2) + '\n');

console.log(`Built ${products.length} product pages, ${CATEGORY_ORDER.filter(k => byCat[k].length).length} category pages, shop page, ${POLICIES.length} info pages; sitemap has ${pages.length} URLs.`);
