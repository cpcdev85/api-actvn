const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

// ============================================================
// BẢO MẬT 1: Secret dùng chung giữa PHP (diem_fetch.php) và server này. Đọc từ biến môi
// trường (đặt trong Render > Environment > API_SECRET), TUYỆT ĐỐI KHÔNG viết cứng trong code
// hay commit lên Git. Nếu chưa cấu hình biến này, TỪ CHỐI TOÀN BỘ request /api/login thay vì
// âm thầm bỏ qua kiểm tra - tránh trường hợp quên set biến môi trường mà endpoint vẫn public
// mở toang mà không ai hay biết (fail-closed thay vì fail-open).
// Trước đây: endpoint này ai cũng gọi thẳng được, không cần qua diem_fetch.php của bạn, biến
// server này thành công cụ dò mật khẩu Microsoft/Office365 miễn phí, ẩn danh cho bất kỳ ai.
// ============================================================
const API_SECRET = process.env.API_SECRET || '';

// ============================================================
// BẢO MẬT 2: Rate-limit đơn giản theo IP, lưu tạm trong RAM. Đủ dùng vì server này chạy dạng
// container dài hạn trên Render (khác Vercel serverless - xem ghi chú tương ứng ở index.js),
// nên không cần cài thêm thư viện ngoài (express-rate-limit) để giữ package.json gọn nhẹ.
// ============================================================
const rateLimitStore = new Map(); // ip -> { count, firstAttemptAt }
const RATE_LIMIT_MAX = 10;                     // tối đa 10 lần
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;   // trong 15 phút

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitStore.get(ip);
    if (!entry || (now - entry.firstAttemptAt) > RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.set(ip, { count: 1, firstAttemptAt: now });
        return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT_MAX;
}

// Dọn dẹp định kỳ để Map không phình to vô hạn theo thời gian.
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitStore.entries()) {
        if ((now - entry.firstAttemptAt) > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(ip);
    }
}, 30 * 60 * 1000);

function getClientIp(req) {
    // Render đặt server sau load balancer của chính họ và tự set đúng 'x-forwarded-for' ở
    // tầng hạ tầng của họ (khác PHP tự host, nơi header này có thể bị client tự giả mạo tự
    // do) - nên ở môi trường Render, tin header này là hợp lý để lấy đúng IP thật của client.
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

// THÊM ĐOẠN NÀY ĐỂ NHẬN BÁO THỨC
app.get('/', (req, res) => {
    res.status(200).send('Máy chủ đang thức!');
});

app.post('/api/login', async (req, res) => {
    // 1. Chặn người lạ gọi thẳng endpoint (bỏ qua diem_fetch.php) bằng secret dùng chung.
    if (!API_SECRET) {
        console.error('LỖI CẤU HÌNH: chưa đặt biến môi trường API_SECRET trên Render - từ chối toàn bộ request để tránh public mở toang.');
        return res.status(500).send('Máy chủ chưa cấu hình bảo mật (API_SECRET).');
    }
    if (req.headers['x-api-secret'] !== API_SECRET) {
        return res.status(403).send('Forbidden');
    }

    // 2. Giới hạn tần suất theo IP - chặn dò mật khẩu hàng loạt / DoS qua puppeteer.launch()
    // (mỗi request khởi chạy nguyên 1 trình duyệt Chromium, rất tốn tài nguyên nếu bị spam).
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
        return res.status(429).send('Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.');
    }

    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Thiếu thông tin');

    let browser = null;
    let page = null;
    
    try {
        console.log("Khởi động trình duyệt...");
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("Truy cập trang chủ trường...");
        await page.goto('https://ktdbcl.actvn.edu.vn/dang-nhap.html', { waitUntil: 'domcontentloaded' });

        console.log("Đang bóc tách link đăng nhập Microsoft...");
        const msAuthUrl = await page.evaluate(() => {
            const btn = document.querySelector('button[data-socialurl*="login.microsoftonline.com"]');
            return btn ? btn.getAttribute('data-socialurl') : null;
        });

        if (msAuthUrl) {
            const cleanUrl = msAuthUrl.replace(/&amp;/g, '&');
            await page.goto(cleanUrl, { waitUntil: 'domcontentloaded' });
        } else {
            // DEBUG TẠM THỜI: in ra 1000 ký tự đầu của HTML trang lúc đó vào log Render, để
            // xác định xem trang đã đổi giao diện, chưa load kịp, hay bị chặn bot. Log này
            // KHÔNG lộ ra ngoài cho client (chỉ xem được qua Render > Logs), và không chứa
            // username/password. Sau khi xác định xong nguyên nhân, nên xoá đoạn debug này.
            try {
                const debugHtml = await page.content();
                console.log("=== DEBUG: không tìm thấy nút Microsoft, 1000 ký tự đầu của trang ===");
                console.log(debugHtml.slice(0, 1000));
                console.log("=== HẾT DEBUG ===");
            } catch (e) {
                console.log("DEBUG: không lấy được page.content() để in log:", e.message);
            }
            throw new Error("Không bóc tách được link Microsoft từ giao diện.");
        }

        console.log("Đợi form điền Email...");
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 30000 });
        await page.type('input[name="loginfmt"]', username);
        await page.click('input[id="idSIButton9"]');

        await new Promise(r => setTimeout(r, 2000));
        
        console.log("Đợi form điền Mật khẩu...");
        await page.waitForSelector('input[name="passwd"]', { visible: true, timeout: 30000 });
        await page.type('input[name="passwd"]', password);
        await page.click('input[id="idSIButton9"]');

        try {
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 5000 });
            await page.click('input[id="idSIButton9"]');
        } catch (e) { }

        console.log("Chờ đăng nhập hoàn tất...");
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

        // --- PHẦN MỚI: XỬ LÝ LẤY ĐIỂM ---
        
        console.log("Đang chuyển hướng sang trang xem điểm...");
        await page.goto('https://ktdbcl.actvn.edu.vn/khao-thi/hvsv/xem-diem-thi.html', { waitUntil: 'networkidle2' });

        console.log("Chọn hiển thị 'Tất cả' môn học...");
        // Lệnh Promise.all này giúp trình duyệt đổi sang "Tất cả" (value '0') VÀ đợi trang load lại xong
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            page.select('#list_limit', '0')
        ]);

        console.log("Đang trích xuất mã HTML của bảng điểm...");
        // Đợi cho cái bảng xuất hiện chắc chắn trên màn hình
        await page.waitForSelector('table.table-bordered', { timeout: 10000 });
        
        // Dùng JavaScript để chỉ cắt đúng mã HTML của cái bảng (table), bỏ đi các phần râu ria (header, menu, footer...)
        const tableHtml = await page.evaluate(() => {
            const table = document.querySelector('table.table-bordered');
            return table ? table.outerHTML : '<p>Không tìm thấy bảng điểm.</p>';
        });

        // Trả về đúng cái bảng điểm
        res.status(200).send(tableHtml);

    } catch (error) {
        let errorMsg = `Lỗi: ${error.message}\n\n`;
        if (page) {
            try {
                const currentUrl = await page.url();
                errorMsg += `--- GÓC DEBUG ---\n`;
                errorMsg += `URL khi bị kẹt: ${currentUrl}\n\n`;
            } catch (e) {}
        }
        res.status(500).send(errorMsg);
    } finally {
        if (browser) await browser.close();
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
