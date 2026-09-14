const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());
// THÊM ĐOẠN NÀY ĐỂ NHẬN BÁO THỨC
app.get('/', (req, res) => {
    res.status(200).send('Máy chủ đang thức!');
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ status: 'bad_request', message: 'Thiếu thông tin' });

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

        // Nếu sai mật khẩu, Microsoft KHÔNG điều hướng trang mà hiện lỗi ngay tại
        // chỗ (id="passwordError"). Bắt song song 2 khả năng: điều hướng thành công
        // HOẶC xuất hiện lỗi sai mật khẩu, để không phải đợi timeout 30s vô ích và để
        // trả đúng thông báo "sai mật khẩu" thay vì lỗi chung chung.
        await page.click('input[id="idSIButton9"]');

        const passwordErrorEl = await Promise.race([
            page.waitForSelector('#passwordError', { visible: true, timeout: 15000 }).then(() => 'wrong_password'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => 'navigated').catch(() => null),
        ]);

        if (passwordErrorEl === 'wrong_password') {
            const msg = await page.$eval('#passwordError', el => el.textContent.trim()).catch(() => 'Sai mật khẩu.');
            return res.status(401).json({ success: false, message: msg || 'Sai tài khoản hoặc mật khẩu.' });
        }

        // Màn hình phụ hay gặp sau khi nhập đúng mật khẩu: "Stay signed in?" / "Duy trì
        // đăng nhập?" / thông báo giảm số lần đăng nhập. Đợi rộng rãi hơn (10s thay vì 5s)
        // vì màn hình này có thể xuất hiện hơi trễ.
        try {
            await page.waitForSelector('input[id="idSIButton9"]', { visible: true, timeout: 10000 });
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
        let debugUrl = null;
        if (page) {
            try { debugUrl = await page.url(); } catch (e) {}
        }
        console.error('[api/login] Lỗi:', error.message, '| URL khi bị kẹt:', debugUrl);

        // QUAN TRỌNG: trả JSON (không phải text thuần) để phía diem_fetch.php parse được
        // và KHÔNG dùng key 'success'/'error' ở đây, vì diem_fetch.php coi 2 key đó là
        // "chắc chắn sai tài khoản/mật khẩu" và sẽ tính vào bộ đếm chống dò mật khẩu -
        // trong khi đây là lỗi automation (timeout, đổi giao diện, MFA...), không liên
        // quan gì đến việc user gõ sai mật khẩu.
        res.status(502).json({
            status: 'automation_error',
            message: 'Không tự động lấy được điểm do lỗi hệ thống (có thể do timeout, trang khảo thí thay đổi giao diện, hoặc tài khoản yêu cầu xác thực 2 bước). Vui lòng thử lại sau hoặc dùng cách Thủ công.',
            debug: error.message,
            stuckUrl: debugUrl,
        });
    } finally {
        if (browser) await browser.close();
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server chạy tại port ' + port));
