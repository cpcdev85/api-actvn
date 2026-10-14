const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const BASE = 'https://ktdbcl.actvn.edu.vn';
const LOGIN_URL = BASE + '/dang-nhap.html';
const GRADES_URL = BASE + '/hvsv.html?view=learnerexams';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Log kèm số giây đã trôi qua từ lúc bắt đầu request (mỗi lần chỉ chạy 1 request nên dùng biến chung được)
let T0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

// Chỉ giữ origin + path của URL khi ghi log / trả lỗi. Phần query (?code=...&state=...) của
// trang callback OAuth chứa mã xác thực tạm thời, không nên lọt vào log Render hay response.
function safeUrl(u) {
    try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return '(không rõ)'; }
}

// Render free chỉ có ~512MB RAM -> chỉ cho chạy 1 trình duyệt tại 1 thời điểm.
// Hàng đợi có giới hạn: quá MAX_PENDING yêu cầu đang chờ thì từ chối ngay (chống tràn RAM/DoS).
const MAX_PENDING = 3;
let pending = 0;
let active = 0; // số request đang chạy (để không đóng Chrome giữa chừng)
let queue = Promise.resolve();
function runExclusive(task) {
    pending++;
    const run = queue.then(task, task).finally(() => { pending--; });
    queue = run.catch(() => {});
    return run;
}

// Khóa bí mật (tùy chọn). Đặt biến môi trường API_KEY trên Render, PHP gửi cùng giá trị trong
// header X-Api-Key. Nếu chưa đặt API_KEY thì bỏ qua kiểm tra (để không làm hỏng hệ thống đang chạy).
const API_KEY = process.env.API_KEY || '';
function requireApiKey(req, res, next) {
    if (!API_KEY) return next();
    const got = String(req.get('x-api-key') || '');
    const a = Buffer.from(got), b = Buffer.from(API_KEY);
    if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) return next();
    return res.status(401).json({ status: 'automation_error', message: 'Unauthorized' });
}

// Lỗi mà ta biết chắc nguyên nhân -> trả đúng status/body cho PHP
class ApiError extends Error {
    constructor(httpStatus, body) {
        super(body.message || 'error');
        this.httpStatus = httpStatus;
        this.body = body;
    }
}

// ---- Trình duyệt dùng chung: chỉ mở 1 lần, các request sau dùng lại (tiết kiệm ~9s) ----
// Mỗi request dùng 1 browser context riêng (như cửa sổ ẩn danh) nên cookie/phiên
// đăng nhập của các sinh viên KHÔNG bị lẫn nhau, và bị xóa sạch khi xong.
let sharedBrowser = null;
let launching = null; // Promise đang mở Chrome - tránh 2 nơi cùng mở 2 Chrome (rò rỉ RAM)
let idleTimer = null;
async function getBrowser() {
    if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;
    if (launching) return launching;
    launching = launchBrowser().finally(() => { launching = null; });
    return launching;
}
async function launchBrowser() {
    log('Khởi động trình duyệt...');
    sharedBrowser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--mute-audio',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
        ],
    });
    sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
    return sharedBrowser;
}
// Không có request trong 3 phút thì đóng Chrome để nhả RAM
function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        if (active > 0 || pending > 0) return scheduleIdleClose(); // đang bận -> hẹn lại
        if (sharedBrowser) { await sharedBrowser.close().catch(() => {}); sharedBrowser = null; }
    }, 3 * 60 * 1000);
}

// Gọi vào "/" (ping đánh thức Render) cũng mở sẵn Chrome luôn
app.get('/', (req, res) => {
    res.status(200).send('Máy chủ đang thức!');
    if (active === 0 && pending === 0) getBrowser().then(scheduleIdleClose).catch(() => {});
});

// ---------------------------------------------------------------
// B1: Đăng nhập trang khảo thí bằng "Sign in with Microsoft"
// ---------------------------------------------------------------
async function goToMicrosoftLogin(page) {
    log('Mở ' + LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Đã mở trang đăng nhập khảo thí');

    // Cách 1: nút Microsoft có sẵn link OAuth trong data-socialurl (cách cũ, nhanh nhất)
    const socialUrl = await page.evaluate(() => {
        const el = document.querySelector('[data-socialurl*="login.microsoftonline.com"]');
        return el ? el.getAttribute('data-socialurl') : null;
    });
    if (socialUrl) {
        log('Có link Microsoft, đang chuyển sang login.microsoftonline.com');
        await page.goto(socialUrl.replace(/&amp;/g, '&'), { waitUntil: 'domcontentloaded', timeout: 60000 });
        log('Đã tới trang Microsoft: ' + safeUrl(page.url()));
        return;
    }

    log('Không thấy data-socialurl, thử bấm nút theo chữ');
    // Cách 2 (dự phòng): tìm nút có chữ "Sign in with Microsoft" rồi bấm
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    const clicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, input[type=button], input[type=submit]')];
        const el = els.find((e) => /sign in with microsoft/i.test((e.textContent || e.value || '')));
        if (!el) return false;
        el.click();
        return true;
    });
    if (!clicked) throw new Error('Không tìm thấy nút "Sign in with Microsoft" trên trang đăng nhập.');
    await nav;
}

async function microsoftLogin(page, username, password) {
    // --- Email ---
    await page.waitForSelector('input[name="loginfmt"]', { visible: true, timeout: 45000 });
    log('Điền email');
    await page.type('input[name="loginfmt"]', username, { delay: 0 });
    await page.click('#idSIButton9');

    // Đợi: hoặc hiện ô mật khẩu, hoặc báo sai email
    const step = await (await page.waitForFunction(() => {
        const vis = (s) => {
            const e = document.querySelector(s);
            return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
        };
        if (vis('#usernameError')) return 'username_error';
        if (vis('input[name="passwd"]')) return 'password';
        return false;
    }, { timeout: 30000, polling: 300 })).jsonValue();

    log('Sau bước email: ' + step);
    if (step === 'username_error') {
        const msg = await page.$eval('#usernameError', (el) => el.textContent.trim()).catch(() => '');
        throw new ApiError(401, { success: false, message: msg || 'Tài khoản không tồn tại.' });
    }

    // --- Mật khẩu ---
    await sleep(500); // đợi hiệu ứng trượt của Microsoft
    log('Điền mật khẩu');
    await page.type('input[name="passwd"]', password, { delay: 0 });
    await page.click('#idSIButton9');
    log('Đã bấm đăng nhập, chờ chuyển về khảo thí');

    // --- Chờ về lại trang khảo thí, xử lý các màn hình phụ ---
    let lastState = '';
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
        let host = '';
        try { host = new URL(page.url()).hostname; } catch (e) {}
        if (host === 'ktdbcl.actvn.edu.vn') break;

        const st = await page.evaluate(() => {
            const vis = (s) => {
                const e = document.querySelector(s);
                return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
            };
            if (vis('#passwordError')) {
                return { type: 'wrong_password', msg: document.querySelector('#passwordError').textContent.trim() };
            }
            const text = document.body ? document.body.innerText : '';
            if (/Approve sign in request|Phê duyệt yêu cầu đăng nhập|Verify your identity|Xác minh danh tính|More information required|Cần thêm thông tin/i.test(text)) {
                return { type: 'mfa' };
            }
            // "Stay signed in?" / "Duy trì đăng nhập?" / màn hình đồng ý quyền
            if (vis('#idSIButton9') && !vis('input[name="passwd"]') && !vis('input[name="loginfmt"]')) {
                return { type: 'click_next' };
            }
            return { type: 'wait' };
        }).catch(() => ({ type: 'wait' })); // trang đang điều hướng -> thử lại

        if (st.type !== lastState) {
            log('Trạng thái: ' + st.type + ' | ' + safeUrl(page.url()));
            lastState = st.type;
        }
        if (st.type === 'wrong_password') {
            throw new ApiError(401, { success: false, message: st.msg || 'Sai tài khoản hoặc mật khẩu.' });
        }
        if (st.type === 'mfa') {
            throw new ApiError(502, {
                status: 'automation_error',
                message: 'Tài khoản đang bật xác thực 2 bước (MFA) nên không thể tự động đăng nhập.',
            });
        }
        if (st.type === 'click_next') {
            await page.click('#idSIButton9').catch(() => {});
        }
        await sleep(500);
    }

    let finalHost = '';
    try { finalHost = new URL(page.url()).hostname; } catch (e) {}
    if (finalHost !== 'ktdbcl.actvn.edu.vn') {
        throw new Error('Hết thời gian chờ đăng nhập Microsoft (URL hiện tại: ' + safeUrl(page.url()) + ')');
    }

    // Đợi trang callback của Joomla xử lý xong phiên đăng nhập rồi mới đi tiếp
    // (không chờ networkidle nữa - tốn ~18s vô ích; chỉ cần chắc không còn ở trang callback)
    await page.waitForFunction(
        () => document.readyState !== 'loading' && !/index\.php/i.test(location.pathname),
        { timeout: 8000 }
    ).catch(() => {});
    log('Đăng nhập xong, đang ở: ' + safeUrl(page.url()));
}

// ---------------------------------------------------------------
// B2: Vào trang xem điểm  +  hiển thị tất cả môn
// ---------------------------------------------------------------
const hasGradeTable = () => {
    return [...document.querySelectorAll('table')].some((t) => /môn thi/i.test(t.innerText));
};

async function openGradesPage(page) {
    await page.goto(GRADES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Đã mở trang điểm, URL: ' + safeUrl(page.url()));

    // Nếu bị đá về trang đăng nhập => chưa đăng nhập được
    if (/dang-nhap/i.test(page.url())) {
        throw new ApiError(401, { success: false, message: 'Đăng nhập khảo thí không thành công.' });
    }

    await page.waitForFunction(hasGradeTable, { timeout: 30000 }).catch(() => {
        throw new Error('Không thấy bảng điểm trên trang ' + safeUrl(page.url()));
    });

    // Đổi "số dòng / trang" (đang là 20) sang "Tất cả"
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    const changed = await page.evaluate(() => {
        const s = document.querySelector('select#list_limit, select[name="list[limit]"], select[name="limit"]');
        if (!s) return false;
        const opts = [...s.options];
        let target = opts.find((o) => o.value === '0') || opts.find((o) => /tất cả|all/i.test(o.text));
        if (!target) target = opts.slice().sort((a, b) => Number(b.value) - Number(a.value))[0]; // lấy số lớn nhất
        if (!target || s.value === target.value) return false;
        s.value = target.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    });
    log(changed ? 'Đã chọn hiển thị tất cả, chờ tải lại' : 'Không đổi được/không cần đổi số dòng');
    if (changed) {
        await nav;
        await page.waitForFunction(hasGradeTable, { timeout: 30000 });
    }
}

// ---------------------------------------------------------------
// B3: Lấy dữ liệu điểm
// ---------------------------------------------------------------
async function extractGrades(page) {
    return page.evaluate(() => {
        const table = [...document.querySelectorAll('table')].find((t) => /môn thi/i.test(t.innerText));
        if (!table) return null;

        const KEYS = {
            '#': 'stt',
            'năm học': 'nam_hoc',
            'học kỳ': 'hoc_ky',
            'môn thi': 'mon_thi',
            'lần': 'lan',
            'tp1': 'tp1',
            'tp2': 'tp2',
            'đqt': 'dqt',
            'điểm thi': 'diem_thi',
            'điểm hp': 'diem_hp',
            'điểm chữ': 'diem_chu',
        };

        const headRow = table.querySelector('thead tr') || table.querySelector('tr');
        const headers = [...headRow.children].map((th) => th.innerText.trim().toLowerCase());

        const rows = [];
        table.querySelectorAll('tbody tr').forEach((tr) => {
            const cells = [...tr.children].map((td) => td.innerText.trim());
            if (cells.length < 3 || cells.length < headers.length / 2) return;
            const obj = {};
            headers.forEach((h, i) => {
                if (!h) return; // cột checkbox
                obj[KEYS[h] || h] = cells[i] !== undefined ? cells[i] : '';
            });
            rows.push(obj);
        });

        return {
            rows,
            html: table.outerHTML,
            paginationDetected: !!document.querySelector('.pagination a'),
        };
    });
}

// ---------------------------------------------------------------
app.post('/api/login', requireApiKey, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ status: 'bad_request', message: 'Thiếu thông tin' });
    }
    if (username.length > 100 || password.length > 255) {
        return res.status(400).json({ status: 'bad_request', message: 'Thông tin không hợp lệ' });
    }
    if (pending >= MAX_PENDING) {
        return res.status(503).json({ status: 'automation_error', message: 'Hệ thống đang bận, vui lòng thử lại sau ít phút.' });
    }

    // Nếu bên gọi (PHP) đã ngắt kết nối trong lúc chờ tới lượt thì khỏi chạy nữa
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) clientGone = true; });

    runExclusive(async () => {
        if (clientGone) return;
        let context = null;
        let page = null;
        T0 = Date.now();
        active++;
        clearTimeout(idleTimer);
        try {
            const browser = await getBrowser();
            context = browser.createBrowserContext
                ? await browser.createBrowserContext()
                : await browser.createIncognitoBrowserContext();
            page = await context.newPage();
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            page.setDefaultTimeout(30000);

            // Bỏ tải ảnh/font/media cho nhẹ RAM và nhanh hơn
            await page.setRequestInterception(true);
            page.on('request', (r) => {
                const t = r.resourceType();
                if (t === 'image' || t === 'font' || t === 'media') r.abort().catch(() => {});
                else r.continue().catch(() => {});
            });

            log('Trình duyệt đã sẵn sàng');
            log('B1: Đăng nhập bằng Microsoft...');
            await goToMicrosoftLogin(page);
            await microsoftLogin(page, username, password);

            log('B2: Mở trang xem điểm...');
            await openGradesPage(page);

            log('B3: Lấy dữ liệu điểm...');
            const result = await extractGrades(page);
            if (!result) throw new Error('Không đọc được bảng điểm.');
            log('Xong: ' + result.rows.length + ' dòng điểm');

            // Giữ tương thích với diem_fetch.php: có field "html" (PHP sẽ lấy field này),
            // thêm "data" là dữ liệu đã tách sẵn thành mảng JSON.
            res.status(200).json({
                status: 'success',
                count: result.rows.length,
                paginationDetected: result.paginationDetected,
                data: result.rows,
                html: result.html,
            });
        } catch (error) {
            if (error instanceof ApiError) {
                return res.status(error.httpStatus).json(error.body);
            }
            let debugUrl = null;
            if (page) { try { debugUrl = safeUrl(page.url()); } catch (e) {} }
            console.error('[api/login] Lỗi:', error.message, '| URL:', debugUrl);

            // KHÔNG dùng key 'success'/'error' ở đây vì diem_fetch.php coi đó là "sai mật khẩu"
            res.status(502).json({
                status: 'automation_error',
                message: 'Không tự động lấy được điểm do lỗi hệ thống (timeout hoặc trang khảo thí thay đổi giao diện). Vui lòng thử lại sau hoặc dùng cách Thủ công.',
                debug: error.message,
                stuckUrl: debugUrl,
            });
        } finally {
            if (context) await context.close().catch(() => {});
            active--;
            scheduleIdleClose();
        }
    });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
