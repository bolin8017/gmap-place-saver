# LINE Bot 親友版設計(gmap-place-saver)

日期:2026-07-27
狀態:已與需求方逐段確認

## 1. 背景與目標

gmap-place-saver 目前是 MCP server + CLI,只有 agent 或工程師能用。目標客群
(愛看美食分享的女性親友)的實際情境是:在 IG/Threads 看到美食貼文 → 想存下
來之後去吃。本設計把「存下來」壓縮成一個動作:**把連結分享給 LINE 機器人,
機器人自動存進她自己的 Google Maps 對應縣市清單**。

Google Maps 個人清單沒有公開寫入 API;本專案用 Playwright 操作已登入的
Chromium profile 完成儲存。因此服務範圍限定在互相信任的親友圈:每位使用者
做一次 Google 登入,伺服器為她保存一份專屬瀏覽器 profile。

## 2. 需求決策(已確認)

| 決策點 | 結論 |
|---|---|
| 規模 | 親友小圈子(<10 人,白名單制) |
| 平台 | LINE Bot(官方 `@line/bot-sdk`) |
| 確認流程 | 高信心自動存;模糊回問候選;存後可一鍵復原 |
| 清單組織 | 預設台灣,22 縣市各一清單,首次存到該縣市才建立 |
| 部署 | 現有機器 + Cloudflare Tunnel,systemd 常駐 |
| v1 輸入 | IG/Threads/FB 連結、Google Maps 連結;其餘回固定說明訊息 |
| 架構 | 同 repo 薄 LINE 層,直接 import 現有核心;不用 LLM |

## 3. 範圍

**做**:LINE webhook server、多用戶 profile 管理、佇列、Flex 訊息、
清單自動建立、`unsavePlace`、儲存歷史與重複偵測、台灣縣市預設設定、
onboarding 流程(管理員手動)、README 文件。

**不做(YAGNI)**:公開註冊、純文字店名輸入、截圖 OCR、自然語言指令、
持久化佇列、LINE 以外的平台、台灣以外的預設分區。

## 4. 架構

```
IG/Threads/FB 分享連結 → LINE 聊天室
        │
        ▼
Cloudflare Tunnel ──► line/server.js(驗簽,立即 200)
        │ enqueue
        ▼
line/queue.js(全域 FIFO,瀏覽器任務併發 = 1)
        │ 以該用戶的 env 呼叫核心
        ▼
resolvePlace ──高信心──► savePlace ──► attachNote(來源連結)
        │                                    │
        └─模糊─► 候選卡片等 postback         ▼
                                   結果卡片(reply,逾時 push)
```

### 新增模組(`line/`)

| 模組 | 職責 |
|---|---|
| `line/server.js` | HTTP server,僅 `POST /webhook`;HMAC 驗簽、回 200、事件進佇列 |
| `line/handlers.js` | 事件分流:訊息抽 URL → 解析存檔;postback → 確認候選/復原 |
| `line/messages.js` | Flex 卡片組裝:結果卡、候選卡、說明與錯誤訊息 |
| `line/queue.js` | 全域 FIFO 佇列;瀏覽器任務一次一個 |
| `line/user-store.js` | 白名單 + LINE userId → `users/<id>/` 目錄對應 |
| `line/pending.js` | 待確認候選(TTL 30 分鐘)與復原 payload(TTL 7 天)的暫存;檔案持久化(`data/line-pending.json`),重啟不失效 |

LINE 層不含地圖邏輯;核心不知道 LINE 存在。橋接方式:bot 為每個任務組出
per-user env,交給現有 `loadConfig(env)`。

### 多用戶目錄佈局

```
users/<lineUserId>/
  profile/              # 該用戶的 Chromium profile(Google 登入 session)
  region-lists.json     # onboarding 時從台灣範本複製,可個別客製
  data/saved-history.jsonl
  data/sidecar-notes/
  logs/
```

解析快取(`GMAP_CACHE`、`GMAP_SOCIAL_CACHE`)與帳號無關,全用戶共用既有
路徑。per-user env 設 `GMAP_HOME=users/<id>`、`GOOGLE_MAPS_PROFILE`、
`GMAP_REGION_CONFIG`、`GMAP_SIDECAR_DIR`,快取項則指回共用路徑。

### 部署與設定

- systemd:`gmap-line-bot`(bot server)、`cloudflared`(tunnel → webhook port)
- `.env` 新增:`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、
  `GMAP_USERS_DIR`(預設 `users/`)、`GMAP_LINE_PORT`(預設 `3080`)
- 新依賴:`@line/bot-sdk`

## 5. LINE 對話體驗

### 主流程(高信心)

1. 用戶丟連結 → bot 開啟 LINE 載入動畫(官方 API,免費,上限 60 秒)
2. 佇列執行:解析 → 存檔 → 附註來源連結(多數 15–45 秒)
3. reply token 回結果卡片:
   > ✅ **小熊菓子 新北斗店** 已存入「彰化縣」清單
   > 彰化縣北斗鎮民族路82號
   > 〔在 Google Maps 開啟〕〔存錯了?復原〕

訊息額度:reply 免費無上限、push 每月免費 200 則。結果一律優先 reply,
逾時或 token 失效才 fallback push;親友規模下 push 用量趨近零。

### 信心判定

- 高信心(自動存):社群 metadata 直接命中店名 + 地址 + 可分區;或
  Google Maps 連結指向明確單一地點
- 模糊(回問):瀏覽器 fallback 找到但比對不完全 → 候選卡片
  「是這間嗎?」〔存這間〕〔不是,取消〕

postback data 上限 300 字元,按鈕只帶短 ID;savePayload 存伺服器端
(`line/pending.js`)。候選 TTL 30 分鐘,過期點按鈕回「請重丟一次連結」。

### 復原與重複

- 〔存錯了?復原〕→ 佇列跑 `unsavePlace` + 刪儲存歷史該筆 → 回
  「已從『彰化縣』移除 ✅」。復原 payload 保留 7 天。
- 同一地點再丟 → 查儲存歷史直接回「這間你 6/12 就存過了 😋」附地圖連結,
  不重跑瀏覽器。

### 其他訊息與 onboarding

- 非支援連結的訊息 → 固定說明訊息(支援的連結類型 + 使用方式)
- 不在白名單 → 禮貌拒絕
- onboarding(管理員手動,每人一次):加 userId 進白名單 → 為
  `users/<id>/profile` 跑現有 noVNC 登入流程,傳一次性連結給親友登入
  Google → 完成。未登入前丟連結,bot 回「還沒完成設定,請找管理員」。

## 6. 核心改造(四項)

1. **台灣縣市預設** — `config/region-lists.taiwan.json`:22 縣市,
   清單名 = 縣市名,關鍵字含正異體(台北市/臺北市)。onboarding 時複製為
   該用戶的 `region-lists.json`。
2. **清單自動建立** — `savePlace` 找不到目標清單時走「+ 新增清單」建立
   後再存;沿用既有的點擊驗證哲學(honest clicks)。
3. **`unsavePlace`(新)** — 開地點頁 → 取消該清單勾選 → 驗證已移除,
   驗證標準比照 `savePlace`。
4. **儲存歷史** — 每用戶 `data/saved-history.jsonl`:placeUrl、店名、
   清單、來源連結、時間。支撐重複偵測與復原。

## 7. 錯誤處理

| 情況 | 行為 |
|---|---|
| 解析失敗 | 回「這個連結我讀不出店家資訊,可以傳 Google Maps 連結試試」 |
| 存檔失敗 | 誠實回報 + 寫入既有 `failureDir` failure log |
| Google session 過期(`signInVisible`) | 回覆用戶「暫時無法存檔」+ push 通知管理員重跑登入 |
| reply token 失效 | fallback push |
| server 重啟 | in-memory 佇列,在跑任務遺失;用戶重丟即可(不做持久化) |

## 8. 安全

- webhook 驗 LINE 簽章;tunnel 僅暴露 webhook 路徑
- 白名單外的訊息不觸發任何瀏覽器動作
- `users/` 權限 700(內含 Google session);`.env` 不進 git
- noVNC 登入連結一次性、密碼保護(沿用現有 login-server)

## 9. 測試

- 單元(`node --test`,沿用現有風格):URL 抽取與訊息分流、台灣設定分區
  路由(含臺/台)、Flex 卡片組裝、pending store TTL、佇列序列化、簽章驗證
- 瀏覽器 smoke(手動,管理員帳號):`unsavePlace`、清單自動建立
- 端到端:管理員 LINE + 測試用戶目錄跑完整流程(分享 → 存檔 → 復原)

## 10. 文件

- README 新增 LINE Bot 一節:建 channel、設 webhook、tunnel、onboarding
- CLAUDE.md(若描述架構)同步更新

## 11. 驗收標準

1. 親友在 IG 複製連結貼進 LINE,60 秒內收到「已存入○○清單」卡片,
   打開她的 Google Maps 能看到該地點在正確縣市清單裡,附註含來源連結
2. 模糊案例收到候選卡片,點〔存這間〕後完成儲存
3. 點〔復原〕後,地點從清單移除
4. 重丟同一地點,收到「已存過」而非重複儲存
5. 白名單外的人得到拒絕訊息,伺服器不啟動瀏覽器
