const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

// ==========================================================
// TỐI ƯU #1 (quan trọng nhất): TÁI SỬ DỤNG 1 TRÌNH DUYỆT DUY NHẤT
// ==========================================================
// Bản gốc: mỗi request gọi puppeteer.launch() rồi browser.close() ở finally
// -> mỗi lần lấy điểm phải khởi động lại Chromium từ đầu. Trên Render free tier
// (CPU bị giới hạn ~0.1 vCPU), riêng bước khởi động Chromium có thể tốn 5-20 giây.
// Bản này: khởi động Chromium 1 LẦN duy nhất khi server start, giữ sống xuyên suốt.
// Mỗi request chỉ mở/đóng "page" (rất nhanh, <1s) thay vì mở/đóng cả "browser".
let browserPromise = null;

function launchBrowser() {
    console.log('[browser] Đang khởi động Chromium...');
    return puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            // Các cờ dưới đây giảm tải CPU/RAM khi chạy trong container giới hạn
            // tài nguyên như Render free tier -> Chromium khởi động & chạy nhanh hơn.
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-extensions',
        ],
    });
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = launchBrowser();
    }
    let browser = await browserPromise;
    // Nếu trình duyệt bị crash/đóng (VD: hết RAM), tự khởi động lại ở lần gọi kế tiếp
    // thay vì để mọi request sau đó lỗi mãi.
    if (!browser.isConnected()) {
        console.log('[browser] Trình duyệt cũ đã ngắt kết nối, khởi động lại...');
        browserPromise = launchBrowser();
        browser = await browserPromise;
    }
    return browser;
}

// ==========================================================
// TỰ ĐỘNG THỬ LẠI KHI GẶP LỖI "Node is detached from document"
// ==========================================================
// Trang đăng nhập Microsoft là một SPA: sau khi DOM vừa tải xong, JS của
// Microsoft có thể vẽ lại (thay thế) form đăng nhập để hiển thị branding của
// trường (logo, tên tổ chức...). Nếu Puppeteer gõ/click đúng lúc phần tử cũ
// vừa bị gỡ khỏi DOM để thay bằng phần tử mới, sẽ gặp lỗi "Node is detached
// from document". Hàm này tự thử lại thao tác (truy vấn lại phần tử mới) một
// vài lần thay vì để cả request thất bại ngay từ lỗi thoáng qua này.
async function retryOnDetached(fn, { retries = 4, delayMs = 500 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!/detached from document/i.test(err.message)) throw err;
            if (i < retries) {
                console.log(`[retry] Phần tử bị detach, thử lại lần ${i + 1}/${retries}...`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }
    throw lastErr;
}

// Route cronjob đang gọi mỗi 15 phút để chống Render ngủ. Tiện thể "làm nóng"
// luôn trình duyệt (đảm bảo Chromium đã khởi động sẵn) để lần lấy điểm đầu tiên
// sau khi container mới khởi động (deploy lại / restart) không phải chờ bước
// khởi động Chromium (bước tốn thời gian nhất).
app.get('/', async (req, res) => {
    getBrowser().catch(err => console.error('[warmup] Lỗi khởi động trình duyệt:', err.message));
    res.status(200).send('Máy chủ đang thức!');
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Thiếu thông tin');

    let page = null;
    const t0 = Date.now();
    const log = (msg) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // ==========================================================
        // TỐI ƯU #2: CHẶN TẢI ẢNH/FONT/VIDEO KHÔNG CẦN THIẾT
        // ==========================================================
        // Ta chỉ cần đọc DOM (điền form, đọc bảng điểm) chứ không cần hiển thị
        // giao diện đẹp -> chặn các tài nguyên nặng giúp trang tải nhanh hơn.
        // LƯU Ý: KHÔNG chặn 'stylesheet' — trang đăng nhập Microsoft là SPA và có
        // logic vẽ lại giao diện có thể phụ thuộc vào việc CSS tải xong, chặn CSS
        // từng khiến trang render không ổn định (một phần nguyên nhân gây lỗi "Node
        // is detached from document"). CSS nhẹ nên không đáng để đánh đổi.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        log('Truy cập trang chủ trường...');
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        log('Đang bóc tách link đăng nhập Microsoft...');
        const msAuthUrl = await page.evaluate(() => {
            const btn = document.querySelector('button[data-socialurl*="login.microsoftonline.com"]');
            return btn ? btn.getAttribute('data-socialurl') : null;
        });

        if (msAuthUrl) {
            const cleanUrl = msAuthUrl.replace(/&amp;/g, '&');
            // TRANG ĐĂNG NHẬP MICROSOFT LÀ SPA: sau domcontentloaded, JS của Microsoft
            // còn tải branding của tenant trường rồi VẼ LẠI form đăng nhập. Nếu thao tác
            // ngay lúc đó, dễ trúng đúng lúc phần tử cũ bị gỡ bỏ -> lỗi "detached from
            // document". Domain login.microsoftonline.com không có nhiều tracker/script
            // nền chạy mãi như trang trường, nên đợi 'networkidle0' ở đây vẫn đủ nhanh mà
            // ổn định hơn nhiều so với domcontentloaded.
            await page.goto(cleanUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        } else {
            throw new Error('Không bóc tách được link Microsoft từ giao diện.');
        }

        log('Đợi form điền Email...');
        // Bọc các thao tác gõ/click trên trang Microsoft bằng retryOnDetached: nếu
        // Microsoft vẽ lại form đúng lúc ta đang thao tác, tự động truy vấn lại phần tử
        // mới và thử lại thay vì để cả request thất bại vì một lỗi thoáng qua.
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 20000 });
        await retryOnDetached(() => page.type('input[name="loginfmt"]', username));
        await retryOnDetached(() => page.click('input[id="idSIButton9"]'));

        log('Đợi form điền Mật khẩu...');
        await page.waitForSelector('input[name="passwd"]', { visible: true, timeout: 20000 });
        await retryOnDetached(() => page.type('input[name="passwd"]', password));
        await retryOnDetached(() => page.click('input[id="idSIButton9"]'));

        try {
            log('Kiểm tra màn hình "Duy trì đăng nhập"...');
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 4000 });
            await retryOnDetached(() => page.click('input[id="idSIButton9"]'));
        } catch (e) { /* Không có màn hình này thì bỏ qua */ }

        log('Chờ đăng nhập hoàn tất, quay về trang trường...');
        // Đây vẫn cần chờ điều hướng thật sự (đăng nhập xong -> redirect về trường),
        // nhưng đổi 'networkidle2' -> 'domcontentloaded' để không phải chờ thêm các
        // request nền không liên quan sau khi DOM đã sẵn sàng.
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });

        // --- PHẦN LẤY ĐIỂM ---

        log('Đang chuyển hướng sang trang xem điểm...');
        await page.goto('https://ktdbcl.actvn.edu.vn/khao-thi/hvsv/xem-diem-thi.html', { waitUntil: 'domcontentloaded' });

        log('Chọn hiển thị "Tất cả" môn học...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
            page.select('#list_limit', '0'),
        ]);

        log('Đang trích xuất mã HTML của bảng điểm...');
        await page.waitForSelector('table.table-bordered', { timeout: 10000 });

        const tableHtml = await page.evaluate(() => {
            const table = document.querySelector('table.table-bordered');
            return table ? table.outerHTML : '<p>Không tìm thấy bảng điểm.</p>';
        });

        log('Hoàn tất.');
        res.status(200).send(tableHtml);

    } catch (error) {
        let errorMsg = `Lỗi: ${error.message}\n\n`;
        if (page) {
            try {
                const currentUrl = await page.url();
                errorMsg += `--- GÓC DEBUG ---\n`;
                errorMsg += `URL khi bị kẹt: ${currentUrl}\n\n`;
            } catch (e) { }
        }
        res.status(500).send(errorMsg);
    } finally {
        // CHỈ đóng "page" (tab), KHÔNG đóng "browser" — trình duyệt được giữ sống
        // xuyên suốt để phục vụ các request tiếp theo (xem TỐI ƯU #1 ở đầu file).
        if (page) {
            try { await page.close(); } catch (e) { }
        }
    }
});

// Khởi động sẵn trình duyệt ngay khi server start, thay vì đợi đến request đầu tiên.
getBrowser().catch(err => console.error('[startup] Lỗi khởi động trình duyệt:', err.message));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
