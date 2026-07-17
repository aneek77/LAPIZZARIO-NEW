#!/usr/bin/env node
/* ============================================================
   La Pizzariô — photo preparer
   Takes a folder of BIG original photos and produces small,
   website-ready images (800×400, ~60-120 KB) with clean names.

   SETUP (one time, in the project folder):
     npm install sharp

   USE:
     1. Make a folder called  originals  in the project folder
        (NEXT TO server.js — NOT inside public/).
     2. Put all your big photos in it. Name each file after the
        dish, spelling doesn't need to be perfect for size/caps:
        "Paneer Tikka Pizza.jpg" → becomes paneer-tikka-pizza.jpg
     3. Run:   node prepare-images.js
     4. Done — compressed copies appear in public/images/ and the
        big originals stay untouched in originals/.
        Check public/images/README.txt for the exact filename each
        menu card expects, and rename any that didn't match.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

let sharp;
try { sharp = require('sharp'); }
catch (e) {
  console.log('\n⚠️  The "sharp" image library is not installed yet.');
  console.log('   Run this once:   npm install sharp');
  console.log('   Then run again:  node prepare-images.js\n');
  process.exit(1);
}

const IN_DIR = path.join(__dirname, 'originals');
const OUT_DIR = path.join(__dirname, 'public', 'images');
const WIDTH = 800, HEIGHT = 400, QUALITY = 80;

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* ---------- Fuzzy matching: your filenames don't need to be exact ----------
   "hawain.jpg", "Cheesy chicken.png", "meal for two offer.jpg" all work —
   each file is matched to the closest official dish/offer name.        */
const OFFICIAL = [
 'Hawain Pizza','Pizzario Garden Fresh','Veggie Deluxe','Cheesy Mushroom Pizza','Cheesy Tomato Pizza',
 'Classic Veg. Pizza','Margherita Pizza','Green Pepper Pizza','Onion Pizza','Golden Corn and Cheese Pizza',
 'Veggie Exotica Pizza','Paneer Tikka Pizza','Corny Paneer Pizza','Cheesy Paneer Pizza','Paneer Deluxe','Kids Delite Pizza',
 'Chicken Hawain Pizza','Chicken Olicano Pizza','Tandoori Chicken Pizza','Hot & Spicy Chicken Pizza',
 'Golden Corn and Chicken Pizza','Chicken Green Pepper Pizza','Pizzario Special Pizza','Chicken & Onion Pizza',
 'Cheesy Chicken Pizza','Chicken Deluxe Pizza','Sizzling Spicy Kebab Pizza','Chicken Supremo Pizza','Chicken Salami Lover Pizza',
 'Classic Veg. Cheese St. Crust','Veggie Exotica St. Crust Pizza','Golden Corn & Cheese St. Crust','Paneer Deluxe St. Crust',
 'Paneer Tikka St. Crust','Margherita St. Crust','Corny Paneer St. Crust','Veg. Hawaiian St. Crust',
 'Tandoori Chicken Cheese St. Crust','Hot & Spicy Cheese St. Crust','Supremo Cheese St. Crust','Chicken Deluxe St. Crust Pizza',
 'Chicken Hawaiian St. Crust Pizza','Golden Corn & Chicken St. Crust','Pizzario Special St. Crust Pizza',
 'Garlic Bread with Cheese','Pizza Pocket Veg.','French Fry','Pizza Pie Sandwich',
 'Garlic Bread Supreme','Fried Chicken Wings','Chicken Sheekh Kebab','Chicken Nuggets','Chicken Popcorn',
 'Pizza Pocket Chicken','Pizza Pie Sandwich Chicken',
 'Veg. Burger','Paneer Burger','Chicken Burger','Chocolava Cake','Brownie','Water','Cold Drink',
 'Onion (Extra Topping)','Capsicum (Extra Topping)','Tomato (Extra Topping)','Oregano (Extra Topping)',
 'Chicken (Extra Topping)','Salami (Extra Topping)','Cheese (Extra Topping)','Paneer (Extra Topping)',
 'Mushroom (Extra Topping)','Olives (Extra Topping)','Jalapenos (Extra Topping)','Sweet Corn (Extra Topping)',
 'Kebab (Extra Topping)','Pineapple (Extra Topping)',
 'Offer Buy One Get One','Offer Executive Meal','Offer Combo Meal Burger','Offer Burger Dessert Combo',
 'Offer Meal for Two','Offer Meal for Four','About Chef'
];
function lev(a, b) {                       // small edit-distance for typo tolerance (hawain/hawaiian)
  const m = a.length, n = b.length;
  const d = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}
const tokens = s => slug(s).split('-').filter(t => t && t !== 'jpg' && t !== 'jpeg' && t !== 'png');
function tokenMatch(t, list) {             // does token t "mean" any token in list?
  return list.some(u => t === u || (t.length > 3 && u.length > 3 && (u.startsWith(t) || t.startsWith(u) || lev(t, u) <= 2)));
}
function scoreAgainst(fileTokens, official) {
  const offT = tokens(official);
  if (offT.length === 0) return 0;
  const hitsOff = offT.filter(t => tokenMatch(t, fileTokens)).length;   // how much of the official name is covered
  const hitsFile = fileTokens.filter(t => tokenMatch(t, offT)).length;  // how much of the filename is used
  return (hitsOff / offT.length) * 0.7 + (fileTokens.length ? hitsFile / fileTokens.length : 0) * 0.3;
}
function bestMatch(filename) {
  const ft = tokens(filename);
  if (ft.length === 0) return null;
  let best = null, bestScore = 0, second = 0;
  for (const o of OFFICIAL) {
    const s = scoreAgainst(ft, o);
    if (s > bestScore) { second = bestScore; bestScore = s; best = o; }
    else if (s > second) second = s;
  }
  return {name: best, score: bestScore, close: bestScore - second < 0.08};
}

async function main() {
  if (!fs.existsSync(IN_DIR)) {
    fs.mkdirSync(IN_DIR);
    console.log('\n📁 Created the "originals" folder next to server.js.');
    console.log('   Put your big photos in it, then run:  node prepare-images.js\n');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(IN_DIR).filter(f => /\.(jpe?g|png|webp|heic|avif)$/i.test(f));
  if (files.length === 0) {
    console.log('\n😕 No photos found in the "originals" folder. Add .jpg/.png files and run again.\n');
    return;
  }

  console.log('\n🍕 Preparing ' + files.length + ' photo(s) → public/images/ (' + WIDTH + '×' + HEIGHT + ', jpg)\n');
  let ok = 0, fail = 0;
  const used = {};
  const warnings = [];
  for (const f of files) {
    const base = path.parse(f).name;
    const m = bestMatch(base);
    let outName, label;
    if (m && m.score >= 0.55) {
      outName = slug(m.name) + '.jpg';
      label = (slug(base) === slug(m.name)) ? '' : '   (matched: "' + m.name + '"' + (m.close ? ' — CHECK, close call' : '') + ')';
      if (m.close) warnings.push(f + ' → ' + outName + '  (had a near-tie — verify it is the right dish)');
    } else {
      outName = slug(base) + '.jpg';
      label = '   (⚠️ no menu match — kept your name; rename if a card stays empty)';
      warnings.push(f + ' → ' + outName + '  (could not match to any menu item)');
    }
    if (used[outName]) {
      console.log('  ⏭️  ' + f + ' skipped — ' + outName + ' already produced from "' + used[outName] + '"');
      warnings.push(f + ' skipped (duplicate of ' + used[outName] + ')');
      continue;
    }
    used[outName] = f;
    const src = path.join(IN_DIR, f);
    const dst = path.join(OUT_DIR, outName);
    try {
      await sharp(src)
        .rotate()                                    // respect phone-camera orientation
        .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' }) // smart crop toward the food
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toFile(dst);
      const kb = Math.round(fs.statSync(dst).size / 1024);
      const inMb = (fs.statSync(src).size / 1048576).toFixed(1);
      console.log('  ✅ ' + f.padEnd(35) + ' → images/' + outName + '  (' + inMb + ' MB → ' + kb + ' KB)' + label);
      ok++;
    } catch (e) {
      console.log('  ❌ ' + f + ' — ' + e.message);
      fail++;
    }
  }
  console.log('\nDone: ' + ok + ' ready' + (fail ? ', ' + fail + ' failed' : '') + '.');
  if (warnings.length) {
    console.log('\n⚠️  Check these ' + warnings.length + ':');
    warnings.forEach(w => console.log('   • ' + w));
  }
  console.log('Open public/images/README.txt to double-check each filename matches its menu card.');
  console.log('Remember: upload public/images to GitHub — but NOT the originals folder.\n');
}
main();
