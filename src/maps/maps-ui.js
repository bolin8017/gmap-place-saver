export function chainText(candidate, depth = candidate.chain?.length || 0) {
  return (candidate.chain || [])
    .slice(0, depth)
    .map((x) => `${x.aria || ''}\n${x.text || ''}`)
    .join('\n');
}

export function scoreNoteCandidate(candidate, criteria = {}) {
  const {
    expectedName = '',
    expectedAddress = '',
    targetList = '',
    negativeNames = [],
    threshold = 8,
  } = criteria;
  const nearText = chainText(candidate, 5);
  const allText = chainText(candidate);
  let score = 0;

  if (expectedName && nearText.includes(expectedName)) score += 12;
  if (expectedAddress && nearText.includes(expectedAddress)) score += 8;
  if (targetList && allText.includes(`已儲存於「${targetList}」`)) score += 3;

  for (const name of negativeNames.filter(Boolean)) {
    if (nearText.includes(name) && !(expectedName && nearText.includes(expectedName))) score -= 20;
  }

  if (nearText.includes('清單說明')) score -= 15;
  if ((candidate.box?.y || 0) > 420) score += 1;

  return score >= threshold && expectedName && !nearText.includes(expectedName) ? score - threshold : score;
}

export function rankNoteCandidates(candidates, criteria = {}) {
  const threshold = criteria.threshold ?? 8;
  return candidates
    .map((candidate) => {
      const score = scoreNoteCandidate(candidate, { ...criteria, threshold });
      return { ...candidate, score, accepted: score >= threshold };
    })
    .sort((a, b) => b.score - a.score);
}

export async function visibleNoteTextareas(page, { selector = 'textarea[aria-label="附註"]', ancestorDepth = 8 } = {}) {
  const tas = page.locator(selector);
  const n = await tas.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ta = tas.nth(i);
    if (!(await ta.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const info = await ta.evaluate((el, depth) => {
      function text(node) { return (node?.innerText || node?.textContent || '').trim(); }
      const chain = [];
      let p = el;
      for (let d = 0; p && d < depth; d++, p = p.parentElement) {
        chain.push({
          tag: p.tagName,
          aria: p.getAttribute('aria-label'),
          role: p.getAttribute('role'),
          text: text(p).slice(0, 800),
        });
      }
      return { value: el.value || '', chain };
    }, ancestorDepth);
    out.push({ i, box: await ta.boundingBox().catch(() => null), ...info });
  }
  return out;
}

export async function selectExactNoteTextarea(page, criteria = {}) {
  const notes = await visibleNoteTextareas(page, criteria);
  const ranked = rankNoteCandidates(notes, criteria);
  return { notes, ranked, best: ranked[0] || null };
}

export function confirmExactPlaceDetail({ body = '', title = '' } = {}, criteria = {}) {
  const { expectedName = '', expectedAddress = '', requireAddress = false } = criteria;
  const titleHasName = Boolean(expectedName && title.includes(expectedName));
  const bodyHasAddress = Boolean(!expectedAddress || body.includes(expectedAddress));

  if (!expectedName) return { confirmed: false, reason: 'missing expectedName' };
  if (!titleHasName) return { confirmed: false, reason: 'title does not contain expectedName' };
  if (requireAddress && !bodyHasAddress) return { confirmed: false, reason: 'body does not contain expectedAddress' };
  return { confirmed: true, titleHasName, bodyHasAddress };
}

export async function waitForBodyIncludes(page, needle, { timeout = 15000, interval = 300 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const body = await page.locator('body').innerText({ timeout: Math.min(1500, interval + 500) }).catch(() => '');
    if (body.includes(needle)) return body;
    await page.waitForTimeout(interval).catch(() => new Promise((r) => setTimeout(r, interval)));
  }
  return page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
}
