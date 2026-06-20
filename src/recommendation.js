// Deterministic, auditable extraction of a short recommendation summary from a
// social caption. No LLM (v1) — the calling agent can rewrite if it wants.

const BOILERPLATE = /(地址|地點|位置|營業|電話|訂位|時間|公休|預約|追蹤|限時|分店|停車|http|www\.|map|google|menu)/i;
const FOOD_HINTS = /(好吃|推薦|必點|必吃|招牌|限定|口感|香|甜|鹹|酥|脆|濃|爆|療癒|驚艷|新鮮|多汁|軟|嫩|麵包|蛋糕|泡芙|甜點|咖啡|拿鐵|料理|餐|飲|湯|肉|菜|飯|麵|餅|串|鍋|🍰|🥐|☕|🍮|😋|🤤|🔥|👍|❤)/u;

export function buildRecommendationSummary(caption, { maxItems = 6, maxLen = 120 } = {}) {
  if (!caption) return '';
  const picks = [];
  for (const raw of String(caption).split('\n')) {
    const line = raw.trim();
    if (line.length < 2 || line.length > 40) continue;
    if (/^[#@]/.test(line)) continue;
    if (BOILERPLATE.test(line)) continue;
    if (!FOOD_HINTS.test(line)) continue;
    const cleaned = line.replace(/#\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    if (cleaned && !picks.includes(cleaned)) picks.push(cleaned);
    if (picks.length >= maxItems) break;
  }
  return picks.join('；').slice(0, maxLen);
}
