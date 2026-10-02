# คู่มือเพิ่มเว็บยาก (แบบ Kakao / Lua Comic)

บันทึกวิธีที่ใช้จริงตอนเพิ่ม Kakao Page และ Lua Comic เพื่อใช้ซ้ำเมื่อเจอเว็บแบบเดียวกัน
เขียนให้ทั้งคนและ Claude อ่าน: เริ่มจาก "แยกประเภท" แล้วทำตามขั้นของประเภทนั้น

---

## 0. กฎที่ห้ามข้าม (ทุกเว็บ)

- **โหลดเฉพาะตอนฟรี** ตอนที่ติดเหรียญ / early access / ปลดล็อกด้วยลิงก์โฆษณา / ล็อกเวลา ต้อง:
  1. ถูกทำเครื่องหมาย `isFree: false` ตั้งแต่ตอนดึงรายชื่อตอน
  2. ถูกปฏิเสธใน `getChapterImages` **ก่อนส่ง request ใด ๆ** (`throw ProtectedContentError`)
  3. ถ้าเซิร์ฟเวอร์ตอบว่าล็อก (paywall, `is_locked`, ไม่มีรูป) ให้ถือเป็นล็อก (`ProtectedContentError`) ห้ามหาทางอื่น
- ห้ามเลี่ยง paywall, DRM, ระบบกันบอท, Cloudflare challenge หรือปลอมตัวเป็นเบราว์เซอร์อื่นเพื่อผ่านการบล็อก
- ห้ามปิดการตรวจ TLS หรือ unset `HTTPS_PROXY` ในสภาพแวดล้อมของ Claude
- ใช้ cookie ของผู้ใช้เองได้เฉพาะแบบ opt-in ต่อ job (แบบ Kakao "Use my existing Kakao access") และไม่ซื้อ / ไม่ปลดล็อกแทนผู้ใช้
- ห้ามบอกว่า "เทสแล้ว" ถ้ายังไม่ได้รันจริง ให้แยก **ทำแล้ว / เทสแล้ว (unit) / ยืนยันกับเว็บจริงแล้ว** ให้ชัด

---

## 1. แยกประเภทเว็บก่อน

| อาการ | ประเภท | ไปที่ |
|---|---|---|
| ต้อง login / มีสิทธิ์ของบัญชี / API ตอบ error code แทนข้อมูล | **แบบ Kakao** | ข้อ 2 |
| `curl` และ Chromium ใน sandbox ได้ 403 "Sorry, you have been blocked" (Cloudflare) | **แบบ Lua** | ข้อ 3 |
| 403 เฉพาะ Chromium headless (WAF บล็อก UA "HeadlessChrome") | แบบ EZ Manga | ข้อ 5 (ใช้ headed + Xvfb ตอนเทส) ผู้ใช้จริงไม่โดน |
| เปิดได้ปกติ มี JSON API | ง่าย | ข้อ 4 อย่างเดียว |

ตรวจเบื้องต้น:

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://SITE/series/xxx      # หน้าเว็บ
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://api.SITE/...          # API
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" https://media.SITE/...        # รูป
```

ให้เช็ก **แยกทีละ host** (หน้าเว็บ / API / รูป) เพราะ Lua บล็อกไม่เท่ากัน: ตอนหลัง API ผ่าน แต่หน้าเว็บกับรูปยัง 403

---

## 2. เว็บแบบ Kakao (ต้องใช้สิทธิ์บัญชี / API ตอบเป็นรหัส)

สิ่งที่ Kakao ทำ (`src/adapters/kakao.js`):

- รายชื่อตอน: `bff-page.kakao.com/api/gateway/api/v2/content/product/list?series_id=…&cursor_index=…&window_size=100&sort_type=asc`
  - เลขตอนใช้ `cursor_index` (ชื่อตอนเป็นข้อความ "…3화" ไม่มีเลขแยก)
  - `isFree = item.is_free === true` (อะไรที่ไม่ใช่ `true` ตรง ๆ = ล็อก)
  - เก็บ `slide_type` ไว้: `SD03` = การ์ตูนรูป, `SD01` = วิดีโอ (ไม่มีหน้าให้โหลด)
- รูปแต่ละตอน: `…/api/v1/viewer/data?series_id=…&product_id=…` → `viewer_data.imageDownloadData.files[].secureUrl`
- ค้นหา: หน้าค้นหาต้อง render ด้วย JS → ใช้แท็บชั่วคราว (`searchInTab` ใน service worker) อ่านผลแล้วปิด
- ปก: API ส่ง `thumbnail` เป็น key ไม่ใช่ URL → ต่อกับ `page-images.kakaoentcdn.com/download/resource?kid=`
- Referer rule (`rules/referer.json`) ตั้ง `https://page.kakao.com/` ให้ทุกโดเมน kakao

บทเรียน:

1. **อ่าน error ของ API ตรง ๆ** ถ้าไม่มี `viewer_data` ให้ส่ง `result_code` / `message` ของเว็บต่อให้ผู้ใช้ (เช่น `-500`) อย่าเดาว่า "ไม่มีสิทธิ์"
2. **ตอนวิดีโอ (SD01)** แจ้งว่าเป็นวิดีโอ ไม่มีหน้าให้โหลด ไม่ใช่ข้อความ "ตรวจสิทธิ์"
3. **โหมดใช้สิทธิ์ของบัญชี** เปิดเองทุก job (ไม่จำค่า) และบอกชัดว่าไม่ได้ซื้อ / ปลดล็อก / ถอด DRM ให้ผู้ใช้ login และเปิดตอนนั้นในเบราว์เซอร์เดียวกันก่อน
4. เทสจากฝั่ง Claude ได้แค่ตอนฟรี ตอนที่ต้องใช้บัญชีต้องให้ผู้ใช้เทสเอง

---

## 3. เว็บแบบ Lua (Cloudflare บล็อกสภาพแวดล้อมของ Claude)

### 3.1 ยืนยันว่าโดนบล็อกจริง (อย่าพยายามหลบ)

- 403 + หน้า "Sorry, you have been blocked" ทั้ง curl และ Chromium = บล็อก IP ไม่ใช่บั๊ก
- web.archive.org / urlscan ก็อาจเข้าไม่ได้จาก sandbox (ลองแล้ว: connection reset / 403)
- **ห้าม**เปลี่ยน UA, ใช้ proxy อื่น, หรือหาทางผ่าน challenge

### 3.2 ขอข้อมูลจากผู้ใช้ (ผู้ใช้เปิดเว็บได้ปกติ)

ขอทีละขั้น สั้น ๆ ชัด ๆ:

1. **ไฟล์หน้าเว็บ** ที่เซฟจากเบราว์เซอร์ (หน้าเรื่อง + หน้าตอนฟรี 1 ตอน)
   - ถ้าได้ "rendered HTML" ที่มี `<script>` ครบ (Next.js `self.__next_f.push`) จะเห็นข้อมูลฝังอยู่ เช่น `\"series_id\":638`
2. **ลิงก์ API ให้เปิดในเบราว์เซอร์แล้ว copy JSON กลับมา** เขียนเป็นข้อ ๆ ให้ตอบเป็นตัวเลข เช่น
   1. `https://api.SITE/series/<slug>`
   2. `https://api.SITE/chapter/<slug>/chapter-1` (ตอนฟรี)
   3. `https://api.SITE/chapter/<slug>/chapter-80` (ตอนเสียเงิน เพื่อดูรูปแบบ paywall)
   4. `https://api.SITE/query?query_string=<คำค้น>`
   - ผู้ใช้จะตอบแบบ "1.404 2.เข้าได้ …" แล้วแปะ JSON ให้
3. ถ้ายังหา endpoint รายชื่อตอนไม่เจอ: ดูใน HTML / JS bundle ที่ผู้ใช้ส่งมาว่าหน้าเว็บเรียก URL อะไร (ค้นคำว่า `api.`, `chapter`, `query`, `series_id`)

เดา endpoint จากระบบที่เว็บใช้: Lua เป็น **HeanCMS** (เห็นจาก `media.reaperscans.net` ใน HTML) จึงลอง path แบบ HeanCMS (`/chapter/query?series_id=…`)

### 3.3 สร้าง adapter จากข้อมูลที่ได้

- เขียน parser เป็นฟังก์ชันบริสุทธิ์ (ไม่มี network) แล้วเทสด้วย JSON ที่ผู้ใช้ส่งมา **ตัดให้สั้นแต่คงรูปแบบจริง** ใส่ใน `test/unit/<site>.test.js`
- หา id ตัวเลขของเรื่องได้ 2 ทาง และต้องมี fallback:
  1. จาก HTML หน้าเรื่อง (regex รับทั้ง `"series_id":638` และ `\"series_id\":638`)
  2. ถ้าหน้าเรื่องโดนบล็อก → เรียก API ตอน (ตอนที่ผู้ใช้วางลิงก์มา, หรือ `chapter-1`, `chapter-0`) แล้วอ่าน `series.id`
     - คำตอบ paywall ก็มี `series.id` อ่านได้ (อ่านแค่ metadata ไม่ใช่รูป)
     - ต้องเช็กว่า `series_slug` ตรงกับเรื่องที่ขอ ไม่งั้นข้าม
- ข้อความ error เมื่อโดน 403/503 ให้บอกผู้ใช้: "เปิดเว็บในเบราว์เซอร์นี้ ผ่านหน้าเช็กก่อน แล้วลองใหม่"
- ไม่ใส่โดเมนที่ไม่มีหลักฐาน (เคยใส่ `luacomic.net` แล้วเอาออก เพราะไม่มีในข้อมูลที่ได้มา จะขอสิทธิ์เกินจำเป็น)

### 3.4 เทสและรายงาน

- unit test ด้วย JSON จริง + mutation check (ลบ guard ตอนเสียเงินแล้วเทสต้องพัง)
- ลองเรียก API จาก sandbox อีกรอบระหว่างทำ (Lua: API กลับมาเข้าได้ภายหลัง ทำให้ยืนยันรายชื่อตอนกับข้อมูลจริงได้)
- รายงานผู้ใช้ตรง ๆ ว่าอะไรยืนยันกับเว็บจริงแล้ว อะไรยังไม่ได้ (เช่น รูปโดนบล็อก โหลดรูปจริงยังไม่ได้เทส)
- ให้ผู้ใช้เทสบนเครื่อง: รีโหลด extension → อนุญาตสิทธิ์ใหม่ → วางลิงก์ → โหลดตอนฟรี 1 ตอน → ลองเลือกตอนเสียเงินต้องถูกข้าม

---

## 4. รายการไฟล์ที่ต้องแก้เมื่อเพิ่มเว็บ

1. `src/adapters/<site>.js` ใช้ contract `{id, label, hostPatterns, capabilities, parseUrl, search, getSeries, getChapterImages}`
   - ctx ที่ใช้ได้: `fetchJson`, `fetchDoc`, `fetchRaw`, `signal`
   - ตอนทศนิยม (152.5) และตอน 0 ต้องใช้ได้
2. `src/adapters/registry.js` เพิ่มเข้า `ADAPTERS`
3. `manifest.json` → `host_permissions` (เฉพาะโดเมนที่มีหลักฐาน) + bump `version` (และ `package.json`)
4. `rules/referer.json` เพิ่ม rule (id ใหม่) ตั้ง Referer เป็นหน้าเว็บนั้น สำหรับ `xmlhttprequest` และ `image`
5. `src/common/following.js` เว็บที่ใช้ slug ใส่ใน `SLUG_SITES` และเพิ่มโดเมนปกใน `safeCover`
6. ถ้ามีค้นหา: `src/ui/app.html` (dropdown "Search site") + `src/ui/app.js` (`selectSearchSite`, hint) + ข้อความใน `_locales/en` และ `_locales/th` ให้จำนวน key เท่ากัน
   - ไฟล์ locale เป็นแบบบรรทัดเดียวต่อ key แก้ทีละบรรทัด อย่า dump JSON ใหม่ทั้งไฟล์
7. `README.md` changelog + ตาราง "Supported sites"
8. เทส: `test/unit/<site>.test.js` แล้วรัน `npm test` และ `npm run test:browser`

---

## 5. เทสจริงใน Chromium (สภาพแวดล้อมของ Claude)

- Playwright `launchPersistentContext` โหลด extension แบบ unpacked, `proxy: { server: process.env.HTTPS_PROXY }` (port เปลี่ยนทุกครั้งที่ container รีสตาร์ท)
- Chromium ไม่เชื่อ CA ของ proxy → import CA จาก `/root/.ccr/ca-bundle.crt` เข้า `~/.pki/nssdb` ด้วย `certutil` (ห้ามปิด TLS)
- ชื่อไฟล์ดาวน์โหลด: ตั้ง `download.default_directory` ใน Preferences ของ profile + CDP `Browser.setDownloadBehavior({behavior:'default'})` ไม่งั้นได้ชื่อเป็น GUID
- ชื่อภาษาเกาหลี/ไทยกลายเป็น `webtoon-<uuid>` → รันด้วย `LANG=C.UTF-8` (ปัญหาของ container ไม่ใช่ของ extension)
- WAF บล็อก "HeadlessChrome" → รันแบบ headed ใต้ `xvfb-run -a`
- `pkill -f` อาจฆ่า shell ตัวเอง → ใช้ pattern แบบ `[c]hrome`
- ตรวจไฟล์ที่ได้: magic bytes ตรงกับนามสกุล, จำนวนหน้า PDF, CRC ของ zip, ลำดับไฟล์, ชื่อไฟล์ตรงกับตอน
