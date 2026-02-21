const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const CreativeAsset = require('../../db/models/CreativeAsset');
const AICreation = require('../../db/models/AICreation');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots } = require('../../db/queries');

const client = new Anthropic({ apiKey: config.claude.apiKey });

const SYSTEM_PROMPT = `You are Claude, senior media buyer and growth strategist for a DTC ecommerce brand running Meta Ads (USA only).

Your job: analyze EVERYTHING — creative bank, account performance, frequency fatigue, scaling opportunities — and propose MULTIPLE ad sets (2-3) ready to launch. Each proposal should have a DIFFERENT strategic angle.

## WHAT YOU RECEIVE
1. **Creative Bank**: All ad-ready assets with styles, performance metrics (CTR, ROAS, times_used)
2. **Account Performance**: ALL ad sets with ROAS, CPA, spend, budget, purchases, FREQUENCY, CTR
3. **Frequency Analysis**: Ad sets flagged with high frequency (audience fatigue)
4. **AI Creation History**: What AI created before — verdict (positive/negative), budget, ROAS, lifecycle phase
5. **AI Managed Ad Sets**: Currently active AI-managed ad sets and their status
6. **Account Context**: Campaign info, total spend, scaling headroom

## YOUR ANALYSIS MUST COVER

### A. FREQUENCY & FATIGUE DETECTION
- Ad sets with frequency > 2.5 are showing fatigue — their audience is seeing ads too much
- If top-performing ad sets have high frequency, they NEED fresh creatives urgently
- Flag which ad sets need creative refresh in your diagnosis
- If multiple ad sets are fatigued, this is a signal to create NEW ad sets with fresh angles

### B. SCALING OPPORTUNITY DETECTION
- If ROAS is strong (>2x) across multiple ad sets AND budgets are conservative, there's room to scale
- Consider: do we need MORE ad sets to scale horizontally? Or just increase budget on existing?
- If AI-managed ad sets are performing well, recommend creating another one with different creatives
- If the bank has many unused creatives, recommend testing them in new ad sets

### C. CREATIVE BANK HEALTH
- How many fresh (unused) creatives are available?
- Are there enough different styles being tested?
- If bank is running low on fresh assets, flag that NEW creatives need to be generated
- Recommend which STYLES of new creatives would be most valuable

### C2. PRODUCT-BASED GROUPING
- Each creative has a "product_name" field identifying which product it represents
- Group ad sets BY PRODUCT — each ad set should focus on ONE product
- Do NOT mix creatives from different products in the same ad set
- If there are multiple products with enough creatives, propose separate ad sets for each
- The ad set name MUST include the product name for easy identification

### D. FOR EACH PROPOSAL — SELECT 4-5 CREATIVES
Pick from the AVAILABLE (unused) creatives list ONLY. Prioritize:
- ONLY select creatives from the "AVAILABLE CREATIVES — UNUSED" list
- Do NOT select creatives from the "ALREADY USED" list unless you are making a genuinely NEW mix (different combination that hasn't been tried before)
- If a product has NO unused creatives left, do NOT propose an ad set for that product — mention it in diagnosis instead
- Mix of styles for testing (don't pick 5 of the same)
- EACH PROPOSAL must use DIFFERENT creatives — do NOT repeat creatives across proposals
- Creatives with has_stories_pair=true will automatically get a 9:16 stories version — prefer these for better placement coverage

For EACH creative, write MULTIPLE ad copy variants to A/B test:
- **headlines**: Array of 3 different headlines. Each: short, punchy, scroll-stopping (max 40 chars) — in English for US audience. Make each one a DIFFERENT angle (benefit, urgency, curiosity, social proof, etc.)
- **bodies**: Array of 3 different primary texts. Each: 2-3 sentences (hook + benefit + CTA) — in English. Different tones: casual, benefit-focused, urgency-driven, etc.
- **cta**: SHOP_NOW | LEARN_MORE | BUY_NOW | GET_OFFER | ORDER_NOW
This creates 3 ads per creative image (one per headline+body pair), giving Meta's algorithm more variants to optimize.

### E. SET THE BUDGET FOR EACH
- Look at average daily budget of WINNING ad sets (ROAS > 1.5)
- Be CONSERVATIVE for new testing ($15-40/day)
- If the account is scaling well, you can go higher ($30-50)
- The AI manager will auto-scale if it works
- Minimum $15/day

### F. NAME EACH AD SET
Format: "AI - [Product Name] - [Style Mix] - [Angle] - [Date]"
Example: "AI - Pickles - Ugly+UGC - Fresh Angles - 2026-02"
The product name comes from the "product_name" field of the selected creatives.

## OUTPUT FORMAT (strict JSON)
Return a JSON object with a "diagnosis" (shared analysis) and "proposals" array (2-3 proposals):

{
  "diagnosis": {
    "frequency_alert": "In Spanish — which ad sets have fatigue and how bad it is",
    "scaling_opportunity": "In Spanish — is there room to scale? how?",
    "creative_bank_health": "In Spanish — how healthy is the bank? what's needed?",
    "recommendation_for_existing": "In Spanish — what should be done with existing ad sets"
  },
  "needs_new_creatives": true/false,
  "suggested_creative_styles": ["ugly-ad", "ugc"],
  "proposals": [
    {
      "adset_name": "AI - ...",
      "product_name": "The product_name shared by the selected creatives (e.g. 'Pickles Artesanales')",
      "daily_budget": 25.00,
      "budget_rationale": "...",
      "selected_creatives": [
        {
          "asset_id": "mongo_id",
          "headlines": ["Headline variant 1", "Headline variant 2", "Headline variant 3"],
          "bodies": ["Body text variant 1", "Body text variant 2", "Body text variant 3"],
          "cta": "SHOP_NOW",
          "rationale": "Why this creative was selected"
        }
      ],
      "strategy_summary": "In Spanish — specific strategy for THIS ad set",
      "expected_outcome": "In Spanish — what you expect from this one",
      "risk_assessment": "low|medium|high"
    }
  ],
  "notes": "Any additional context in Spanish"
}

IMPORTANT:
- Return ONLY valid JSON, no markdown fences
- Return 2-3 proposals with DIFFERENT angles/styles/creatives
- If bank has < 8 unused creatives, you may return only 2 proposals
- If bank has < 4 unused creatives, return only 1 proposal
- If bank has 0 unused creatives, return 0 proposals and explain in diagnosis
- Select exactly 4-5 creatives per proposal (minimum 2 if bank is small)
- Do NOT select already-used creatives unless making a genuinely new mix
- Do NOT repeat the same creatives across proposals
- Ad copy in English (US audience), strategy/diagnosis in Spanish (for the team)
- Be SPECIFIC and DATA-DRIVEN in diagnosis — cite actual numbers
- The diagnosis section is critical — the team needs to know what's happening in the account`;

async function strategize() {
  const startTime = Date.now();
  const meta = getMetaClient();

  // 1. Fetch creative bank (ad-ready FEED images only — 9:16 stories are auto-paired)
  const allCreatives = await CreativeAsset.find({
    status: 'active',
    purpose: 'ad-ready',
    media_type: 'image'
  }).lean();

  // Separate: feed (1:1) for selection, stories (9:16) are paired automatically
  const feedCreatives = allCreatives.filter(c => c.ad_format !== 'stories');
  const unusedFeedCreatives = feedCreatives.filter(c => (c.times_used || 0) === 0);
  const usedFeedCreatives = feedCreatives.filter(c => (c.times_used || 0) > 0);

  if (feedCreatives.length < 2) {
    throw new Error('Se necesitan al menos 2 creativos ad-ready formato feed (1:1) en el banco para crear un ad set');
  }

  // 2. Fetch account performance — ALL ad sets, not just top 15
  let adsetSnapshots = [];
  try {
    adsetSnapshots = await getLatestSnapshots('adset');
  } catch (e) {
    logger.warn('No se pudieron obtener snapshots de ad sets:', e.message);
  }

  // 3. Fetch AI creation history
  const aiHistory = await AICreation.find({})
    .sort({ created_at: -1 })
    .limit(30)
    .lean();

  // 4. Get currently AI-managed ad sets
  const aiManaged = await AICreation.find({
    creation_type: 'create_adset',
    managed_by_ai: true,
    lifecycle_phase: { $nin: ['dead'] }
  }).lean();

  // 5. Get campaign info
  let campaigns = [];
  try {
    campaigns = await meta.getCampaigns();
  } catch (e) {
    logger.warn('No se pudieron obtener campañas:', e.message);
  }

  // 6. Calculate deep account metrics
  const activeSnapshots = adsetSnapshots.filter(s => s.status === 'ACTIVE');
  const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
  const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
  const totalPurchases7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchases || 0), 0);
  const totalPurchaseValue7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);
  const accountRoas = totalSpend7d > 0 ? totalPurchaseValue7d / totalSpend7d : 0;

  // 7. Frequency analysis — flag fatigued ad sets
  const frequencyAnalysis = adsetSnapshots
    .filter(s => s.status === 'ACTIVE' && (s.metrics?.last_7d?.frequency || 0) > 0)
    .map(s => ({
      name: s.entity_name || s.name,
      entity_id: s.entity_id,
      frequency: s.metrics?.last_7d?.frequency || 0,
      roas_7d: s.metrics?.last_7d?.roas || 0,
      ctr_7d: s.metrics?.last_7d?.ctr || 0,
      spend_7d: s.metrics?.last_7d?.spend || 0,
      daily_budget: s.daily_budget || 0,
      is_fatigued: (s.metrics?.last_7d?.frequency || 0) > 2.5,
      fatigue_level: (s.metrics?.last_7d?.frequency || 0) > 4 ? 'critical' :
                     (s.metrics?.last_7d?.frequency || 0) > 3 ? 'high' :
                     (s.metrics?.last_7d?.frequency || 0) > 2.5 ? 'moderate' : 'ok'
    }))
    .sort((a, b) => b.frequency - a.frequency);

  const fatiguedCount = frequencyAnalysis.filter(f => f.is_fatigued).length;

  // 8. Creative bank health (based on feed creatives only)
  const styleDistribution = {};
  feedCreatives.forEach(c => {
    const s = c.style || 'other';
    styleDistribution[s] = (styleDistribution[s] || 0) + 1;
  });

  // Product distribution for analysis (computed here, before bankHealth uses it)
  const productDistribution = {};
  feedCreatives.forEach(c => {
    const p = c.product_name || 'unknown';
    productDistribution[p] = (productDistribution[p] || 0) + 1;
  });

  // 9. Fetch reference images (product base) — so strategist knows which products exist
  const referenceImages = await CreativeAsset.find({
    status: 'active',
    purpose: 'reference',
    media_type: 'image'
  }).select('_id product_name filename headline original_name').lean();

  const accountContext = {
    total_daily_budget: Math.round(totalBudget * 100) / 100,
    active_adsets: activeSnapshots.length,
    avg_budget: activeSnapshots.length > 0 ? Math.round(totalBudget / activeSnapshots.length) : 25,
    total_spend_7d: Math.round(totalSpend7d * 100) / 100,
    total_purchases_7d: totalPurchases7d,
    account_roas_7d: Math.round(accountRoas * 100) / 100,
    fatigued_adsets: fatiguedCount,
    ai_managed_active: aiManaged.length
  };

  // Build set of product names that have stories (9:16) assets available
  const storiesAssets = allCreatives.filter(c => c.ad_format === 'stories');
  const productsWithStories = new Set(storiesAssets.map(c => c.product_name).filter(Boolean));

  // Determine has_stories_pair: direct paired_asset_id OR a stories asset exists for same product
  const hasStoriesPair = (c) => {
    if (c.paired_asset_id) return true;
    if (c.product_name && productsWithStories.has(c.product_name)) return true;
    return false;
  };

  const storiesWithPairs = feedCreatives.filter(c => hasStoriesPair(c)).length;

  const bankHealth = {
    total_feed_assets: feedCreatives.length,
    unused_feed_assets: unusedFeedCreatives.length,
    used_feed_assets: usedFeedCreatives.length,
    stories_pairs: storiesWithPairs,
    style_distribution: styleDistribution,
    product_distribution: productDistribution,
    avg_times_used: feedCreatives.length > 0 ? Math.round(feedCreatives.reduce((s, c) => s + (c.times_used || 0), 0) / feedCreatives.length * 10) / 10 : 0
  };

  // Build contexts — only UNUSED feed creatives are selectable
  const creativesContext = unusedFeedCreatives.map(c => ({
    id: c._id.toString(),
    headline: c.headline || c.original_name,
    product_name: c.product_name || '',
    style: c.style,
    generated_by: c.generated_by,
    has_stories_pair: hasStoriesPair(c),
    avg_ctr: c.avg_ctr || 0,
    avg_roas: c.avg_roas || 0,
    tags: c.tags || [],
    notes: c.notes || '',
    has_body: !!(c.body),
    has_link: !!(c.link_url),
    created_at: c.created_at
  }));

  // Used creatives — for context only, Claude should NOT select these unless mixing
  const usedCreativesContext = usedFeedCreatives.map(c => ({
    id: c._id.toString(),
    headline: c.headline || c.original_name,
    product_name: c.product_name || '',
    style: c.style,
    times_used: c.times_used || 0,
    used_in_adsets: (c.used_in_adsets || []).length,
    has_stories_pair: hasStoriesPair(c),
    avg_ctr: c.avg_ctr || 0,
    avg_roas: c.avg_roas || 0
  }));

  const performanceContext = adsetSnapshots.map(s => ({
    name: s.entity_name || s.name,
    entity_id: s.entity_id,
    status: s.status,
    daily_budget: s.daily_budget || 0,
    roas_7d: s.metrics?.last_7d?.roas || 0,
    roas_3d: s.metrics?.last_3d?.roas || 0,
    cpa_7d: s.metrics?.last_7d?.cpa || 0,
    ctr_7d: s.metrics?.last_7d?.ctr || 0,
    spend_7d: s.metrics?.last_7d?.spend || 0,
    purchases_7d: s.metrics?.last_7d?.purchases || 0,
    frequency_7d: s.metrics?.last_7d?.frequency || 0,
    impressions_7d: s.metrics?.last_7d?.impressions || 0
  }));

  const aiHistoryContext = aiHistory.map(h => ({
    type: h.creation_type,
    name: h.meta_entity_name,
    verdict: h.verdict,
    initial_budget: h.initial_budget,
    current_budget: h.current_budget || h.initial_budget,
    lifecycle_phase: h.lifecycle_phase,
    managed_by_ai: h.managed_by_ai || false,
    roas_7d: h.metrics_7d?.roas_7d || 0,
    spend_7d: h.metrics_7d?.spend || 0,
    child_ads: h.child_ad_ids?.length || 0,
    actions_taken: h.lifecycle_actions?.length || 0,
    created_at: h.created_at
  }));

  const aiManagedContext = aiManaged.map(m => ({
    name: m.meta_entity_name,
    adset_id: m.meta_entity_id,
    phase: m.lifecycle_phase,
    budget: m.current_budget || m.initial_budget,
    ads: m.child_ad_ids?.length || 0,
    days_active: Math.round((Date.now() - new Date(m.created_at)) / (1000 * 60 * 60 * 24)),
    roas_7d: m.metrics_7d?.roas_7d || 0,
    verdict: m.verdict
  }));

  const userMessage = `Analyze the following data and propose a complete ad set. Pay special attention to frequency fatigue and scaling opportunities.

## AVAILABLE CREATIVES — UNUSED (${unusedFeedCreatives.length} feed 1:1 assets ready to use)
These are the ONLY creatives you can select for proposals. They have never been used in an ad set.
${JSON.stringify(creativesContext, null, 2)}

## ALREADY USED CREATIVES — DO NOT SELECT (${usedFeedCreatives.length} assets)
These creatives have already been used in ad sets. Do NOT select them UNLESS you are proposing a genuinely different MIX (different product combination or angle that hasn't been tried). If ALL unused creatives for a product have been exhausted, you may reuse one to complete a mix.
${JSON.stringify(usedCreativesContext, null, 2)}

## BANK HEALTH
${JSON.stringify(bankHealth, null, 2)}

## ACCOUNT PERFORMANCE — ALL AD SETS (${adsetSnapshots.length} total)
${JSON.stringify(performanceContext, null, 2)}

## FREQUENCY ANALYSIS (${fatiguedCount} fatigued)
${JSON.stringify(frequencyAnalysis, null, 2)}

## ACCOUNT OVERVIEW
${JSON.stringify(accountContext, null, 2)}

## AI CREATION HISTORY (last ${aiHistory.length})
${JSON.stringify(aiHistoryContext, null, 2)}

## CURRENTLY AI-MANAGED AD SETS (${aiManaged.length} active)
${JSON.stringify(aiManagedContext, null, 2)}

## AVAILABLE PRODUCT BASE IMAGES (reference photos for each product)
${referenceImages.length > 0 ? referenceImages.map(r => `- product_name: "${r.product_name || r.headline || r.original_name}" | filename: ${r.filename}`).join('\n') : 'No reference images available'}
NOTE: Each proposal MUST include a "product_name" field matching one of the products above. This is used to link the ad set to its product base image.

## CAMPAIGN
${campaigns.length > 0 ? `Campaign: "${campaigns[0].name}" (${campaigns[0].id}) — Status: ${campaigns[0].effective_status}` : 'No campaign data available'}

Today: ${new Date().toISOString().split('T')[0]}

IMPORTANT: If there are NO unused creatives available for any product, do NOT propose an ad set for that product. Say so in the diagnosis instead.
Creatives with has_stories_pair=true will automatically get a 9:16 stories ad created alongside the feed ad — no action needed from you.

Analyze everything. Propose 2-3 ad sets with DIFFERENT angles. Be specific about frequency issues and scaling opportunities in your diagnosis.`;

  const response = await client.messages.create({
    model: config.claude.model,
    max_tokens: 10000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON
  let result;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    result = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    logger.error('Error parsing strategist response:', text.substring(0, 500));
    throw new Error(`Claude no devolvió JSON válido: ${parseErr.message}`);
  }

  // Validate each proposal's creatives exist in bank
  const proposals = result.proposals || [];
  if (proposals.length === 0) {
    throw new Error('Claude no devolvió ninguna propuesta');
  }

  const validatedProposals = [];
  for (const proposal of proposals) {
    const validCreatives = [];
    for (const sel of (proposal.selected_creatives || [])) {
      const asset = feedCreatives.find(c => c._id.toString() === sel.asset_id)
        || usedFeedCreatives.find(c => c._id.toString() === sel.asset_id);
      if (asset) {
        // Normalize: ensure headlines/bodies are arrays (backwards compat with old single format)
        const headlines = Array.isArray(sel.headlines) ? sel.headlines :
          (sel.headline ? [sel.headline] : [asset.headline || asset.original_name]);
        const bodies = Array.isArray(sel.bodies) ? sel.bodies :
          (sel.body ? [sel.body] : [asset.body || '']);

        validCreatives.push({
          ...sel,
          headlines,
          bodies,
          asset_filename: asset.filename,
          asset_style: asset.style,
          asset_headline: asset.headline || asset.original_name,
          asset_ad_format: asset.ad_format || '',
          has_stories_pair: !!asset.paired_asset_id,
          paired_asset_id: asset.paired_asset_id ? asset.paired_asset_id.toString() : null
        });
      } else {
        logger.warn(`Strategist selected non-existent asset: ${sel.asset_id}`);
      }
    }

    if (validCreatives.length < 2) {
      logger.warn(`Proposal "${proposal.adset_name}" tiene menos de 2 creativos válidos, saltando`);
      continue;
    }

    // Resolve product_name — from Claude's output or infer from the selected creatives
    let proposalProductName = proposal.product_name || '';
    if (!proposalProductName) {
      // Infer from most common product_name in selected creatives
      const productCounts = {};
      for (const sel of validCreatives) {
        const asset = feedCreatives.find(c => c._id.toString() === sel.asset_id);
        const pn = asset?.product_name || '';
        if (pn) productCounts[pn] = (productCounts[pn] || 0) + 1;
      }
      const sorted = Object.entries(productCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) proposalProductName = sorted[0][0];
    }

    // Find matching reference image for this product
    let productReferenceFilename = '';
    if (proposalProductName && referenceImages.length > 0) {
      const match = referenceImages.find(r =>
        (r.product_name || '').toLowerCase() === proposalProductName.toLowerCase()
      );
      if (match) {
        productReferenceFilename = match.filename;
      }
    }

    validatedProposals.push({
      ...proposal,
      product_name: proposalProductName,
      product_reference_filename: productReferenceFilename,
      selected_creatives: validCreatives
    });
  }

  if (validatedProposals.length === 0) {
    throw new Error('Ninguna propuesta tiene creativos válidos');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    diagnosis: result.diagnosis || {},
    needs_new_creatives: result.needs_new_creatives || false,
    suggested_creative_styles: result.suggested_creative_styles || [],
    notes: result.notes || '',
    proposals: validatedProposals,
    campaign_id: campaigns[0]?.id || null,
    campaign_name: campaigns[0]?.name || null,
    creatives_in_bank: feedCreatives.length,
    unused_in_bank: unusedFeedCreatives.length,
    fatigued_adsets: fatiguedCount,
    account_roas: Math.round(accountRoas * 100) / 100,
    ai_managed_count: aiManaged.length,
    analysis_time_s: elapsed
  };
}

module.exports = { strategize };
