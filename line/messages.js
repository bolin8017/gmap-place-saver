// Builders return LINE Messaging API message objects:
// https://developers.line.biz/en/reference/messaging-api/#message-objects
// All copy is Traditional Chinese; postback data stays far below the 300-char cap.

const postbackData = (t, id) => JSON.stringify({ t, id });
const text = (value) => ({ type: 'text', text: value });

export function helpMessage() {
  return text('把 IG、Threads、Facebook 或 Google Maps 的店家連結分享給我,我就幫妳存進 Google Maps 收藏 ❤️');
}

export function rejectMessage() {
  return text('這是私人機器人,目前只服務小圈圈的朋友們 🙇');
}

export function notOnboardedMessage() {
  return text('妳的帳號還沒完成設定(需要做一次 Google 登入),請找管理員幫忙開通 🔑');
}

export function resolveFailedMessage() {
  return text('這個連結我讀不出店家資訊 😢 可以改傳 Google Maps 的店家連結試試');
}

export function cannotRouteMessage(placeName) {
  return text(`找到「${placeName}」,但我判斷不出它屬於哪個縣市清單 😵(目前只支援台灣的店家)`);
}

export function saveFailedMessage(placeName) {
  return text(`找到了「${placeName}」但存檔沒有成功 😥 請稍後再丟一次,或找管理員看看`);
}

export function jobFailedMessage() {
  return text('處理的時候出錯了 😢 請稍後再試一次');
}

export function sessionExpiredMessage() {
  return text('暫時無法存檔(Google 登入狀態過期了),已通知管理員修復,晚點再試 🙏');
}

export function adminSessionAlert(userId, name) {
  return text(`⚠️ ${name || userId} 的 Google session 過期了,請重跑登入:\nGOOGLE_MAPS_PROFILE=users/${userId}/profile ./scripts/login-server.sh`);
}

// The whole point of the tunnel watchdog is that an unreachable bot used to
// look exactly like a quiet one. This is the message that breaks that silence,
// so it names the machine-side action rather than reassuring anyone.
export function adminTunnelAlert(reason) {
  return text(`⚠️ 機器人對外無法連線(${reason})。已自動重開 tunnel;若連續收到這則訊息,請上機器檢查:\n  systemctl --user status gmap-line-tunnel`);
}

export function alreadySavedMessage(entry) {
  const when = (entry.at || '').slice(0, 10);
  const link = entry.mapsUrl ? `\n${entry.mapsUrl}` : '';
  return text(`這間「${entry.placeName}」${when ? `妳 ${when} ` : '妳'}就存過了 😋 在「${entry.listName}」清單裡${link}`);
}

export function undoneMessage(listName) {
  return text(`已從「${listName}」清單移除 ✅`);
}

export function undoFailedMessage(entry) {
  const link = entry.mapsUrl ? `\n${entry.mapsUrl}` : '';
  return text(`復原沒有成功 😥 可以打開地點自己取消儲存:${link}`);
}

export function canceledMessage() {
  return text('好,先不存 👌 想存的時候再丟連結給我');
}

export function expiredMessage() {
  return text('這個按鈕過期了,請再丟一次連結給我 🙏');
}

export function resultCard({ placeName, address, listName, mapsUrl, undoId }) {
  const body = [
    { type: 'text', text: `✅ 已存入「${listName}」`, size: 'sm', color: '#1a7f37', weight: 'bold' },
    { type: 'text', text: placeName, size: 'lg', weight: 'bold', wrap: true },
  ];
  if (address) body.push({ type: 'text', text: address, size: 'sm', color: '#888888', wrap: true });
  const footer = [];
  if (mapsUrl) {
    footer.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '在 Google Maps 開啟', uri: mapsUrl } });
  }
  footer.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '存錯了?復原', data: postbackData('undo', undoId), displayText: '復原上一筆儲存' } });
  return {
    type: 'flex',
    altText: `已存入「${listName}」:${placeName}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer },
    },
  };
}

export function candidateCard({ placeName, address, listName, confirmId, cancelId }) {
  const body = [
    { type: 'text', text: '是這間嗎?🤔', size: 'sm', color: '#8a6d1a', weight: 'bold' },
    { type: 'text', text: placeName, size: 'lg', weight: 'bold', wrap: true },
  ];
  if (address) body.push({ type: 'text', text: address, size: 'sm', color: '#888888', wrap: true });
  body.push({ type: 'text', text: `會存入「${listName}」清單`, size: 'sm', color: '#888888' });
  return {
    type: 'flex',
    altText: `是這間嗎?${placeName}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: '對,存這間!', data: postbackData('save', confirmId), displayText: '存這間' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '不是,先不存', data: postbackData('cancel', cancelId), displayText: '先不存' } },
        ],
      },
    },
  };
}
