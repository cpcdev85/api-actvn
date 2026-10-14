const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const BASE = 'https://ktdbcl.actvn.edu.vn';
const LOGIN_URL = BASE + '/dang-nhap.html';
const GRADES_URL = BASE + '/hvsv.html?view=learnerexams';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Render free chỉ có ~512MB RAM -> chỉ cho chạy 1 trình duyệt tại 1 thời điểm
let queue = Promise.resolve();
function runExclusive(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

// Lỗi mà ta biết chắc nguyên nhân -> trả đúng status/body cho PHP
class ApiError extends Error {
    constructor(httpStatus, body) {
        super(body.message || 'error');
        this.httpStatus = httpStatus;
        this.body = body;
    }
}

app.get('/', (req, res) => res.status(200).send('Máy chủ đang thức!'));

// ---------------------------------------------------------------
// B1: Đăng nhập trang khảo thí bằng "Sign in with Microsoft"
// ---------------------------------------------------------------
async function goToMicrosoftLogin(page) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Cách 1: nút Microsoft có sẵn link OAuth trong data-socialurl (cách cũ, nhanh nhất)
    const socialUrl = await page.evaluate(() => {
        const el = document.querySelector('[data-socialurl*="login.microsoftonline.com"]');
        return el ? el.getAttribute('data-socialurl') : null;
    });
    if (socialUrl) {
        await page.goto(socialUrl.replace(/&amp;/g, '&'), { waitUntil: 'domcontentloaded', timeout: 45000 });
        return;
    }

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
    await page.waitForSelector('input[name="loginfmt"]', { visible: true, timeout: 30000 });
    await page.type('input[name="loginfmt"]', username, { delay: 20 });
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

    if (step === 'username_error') {
        const msg = await page.$eval('#usernameError', (el) => el.textContent.trim()).catch(() => '');
        throw new ApiError(401, { success: false, message: msg || 'Tài khoản không tồn tại.' });
    }

    // --- Mật khẩu ---
    await sleep(500); // đợi hiệu ứng trượt của Microsoft
    await page.type('input[name="passwd"]', password, { delay: 20 });
    await page.click('#idSIButton9');

    // --- Chờ về lại trang khảo thí, xử lý các màn hình phụ ---
    const deadline = Date.now() + 60000;
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
        throw new Error('Hết thời gian chờ đăng nhập Microsoft (URL hiện tại: ' + page.url() + ')');
    }

    // Đợi trang callback của Joomla xử lý xong phiên đăng nhập rồi mới đi tiếp
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
}

// ---------------------------------------------------------------
// B2: Vào trang xem điểm  +  hiển thị tất cả môn
// ---------------------------------------------------------------
const hasGradeTable = () => {
    return [...document.querySelectorAll('table')].some((t) => /môn thi/i.test(t.innerText));
};

async function openGradesPage(page) {
    await page.goto(GRADES_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Nếu bị đá về trang đăng nhập => chưa đăng nhập được
    if (/dang-nhap/i.test(page.url())) {
        throw new ApiError(401, { success: false, message: 'Đăng nhập khảo thí không thành công.' });
    }

    await page.waitForFunction(hasGradeTable, { timeout: 30000 }).catch(() => {
        throw new Error('Không thấy bảng điểm trên trang ' + page.url());
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
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ status: 'bad_request', message: 'Thiếu thông tin' });
    }

    runExclusive(async () => {
        let browser = null;
        let page = null;
        try {
            console.log('Khởi động trình duyệt...');
            browser = await puppeteer.launch({
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-blink-features=AutomationControlled',
                ],
            });

            page = await browser.newPage();
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

            console.log('B1: Đăng nhập bằng Microsoft...');
            await goToMicrosoftLogin(page);
            await microsoftLogin(page, username, password);

            console.log('B2: Mở trang xem điểm...');
            await openGradesPage(page);

            console.log('B3: Lấy dữ liệu điểm...');
            const result = await extractGrades(page);
            if (!result) throw new Error('Không đọc được bảng điểm.');

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
            if (page) { try { debugUrl = page.url(); } catch (e) {} }
            console.error('[api/login] Lỗi:', error.message, '| URL:', debugUrl);

            // KHÔNG dùng key 'success'/'error' ở đây vì diem_fetch.php coi đó là "sai mật khẩu"
            res.status(502).json({
                status: 'automation_error',
                message: 'Không tự động lấy được điểm do lỗi hệ thống (timeout hoặc trang khảo thí thay đổi giao diện). Vui lòng thử lại sau hoặc dùng cách Thủ công.',
                debug: error.message,
                stuckUrl: debugUrl,
            });
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
