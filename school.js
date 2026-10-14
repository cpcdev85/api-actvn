const SCHOOL_ORIGIN = 'https://ktdbcl.actvn.edu.vn';
const GRADES_URL = `${SCHOOL_ORIGIN}/hvsv.html?view=learnerexams`;

class AuthenticationError extends Error {}

async function login(page, username, password) {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    await page.goto(`${SCHOOL_ORIGIN}/dang-nhap.html`, { waitUntil: 'domcontentloaded' });
    const authUrl = await page.evaluate(() => {
        const button = document.querySelector('[data-socialurl*="login.microsoftonline.com"]');
        return button ? button.getAttribute('data-socialurl') : null;
    });
    if (!authUrl) throw new Error('Không tìm thấy nút đăng nhập Microsoft.');
    const target = new URL(authUrl.replace(/&amp;/g, '&'));
    if (target.protocol !== 'https:' || target.hostname !== 'login.microsoftonline.com') {
        throw new Error('Địa chỉ đăng nhập Microsoft không hợp lệ.');
    }
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="loginfmt"]', { visible: true });
    await page.type('input[name="loginfmt"]', username);
    await page.click('#idSIButton9');
    const next = await page.waitForFunction(() => {
        const visible = el => el && el.getClientRects().length > 0;
        const error = document.querySelector('#usernameError');
        if (visible(error) && error.textContent.trim()) return { error: error.textContent.trim() };
        return visible(document.querySelector('input[name="passwd"]')) ? { password: true } : false;
    });
    const state = await next.jsonValue();
    await next.dispose();
    if (state.error) throw new AuthenticationError(state.error);
    await page.type('input[name="passwd"]', password);
    await page.click('#idSIButton9');

    // Observe the destination/state directly: navigation may finish before a wait is registered.
    // Only click the confirmation on the identifiable "Stay signed in" screen.
    let confirmed = false;
    for (;;) {
        const handle = await page.waitForFunction((origin, alreadyConfirmed) => {
            if (location.origin === origin) return { done: true };
            const visible = el => el && el.getClientRects().length > 0;
            for (const selector of ['#passwordError', '#usernameError']) {
                const error = document.querySelector(selector);
                if (visible(error) && error.textContent.trim()) return { error: error.textContent.trim() };
            }
            const stay = document.querySelector('#KmsiDescription, #kmsiDescription, #kmsiForm');
            if (!alreadyConfirmed && visible(stay) && visible(document.querySelector('#idSIButton9'))) {
                return { confirm: true };
            }
            return false;
        }, { timeout: 30000 }, SCHOOL_ORIGIN, confirmed);
        const result = await handle.jsonValue();
        await handle.dispose();
        if (result.error) throw new AuthenticationError(result.error);
        if (result.done) return;
        confirmed = true;
        await page.click('#idSIButton9');
    }
}

// This function runs in the browser, so it has no Node-side dependencies.
function extractGradeTable() {
    const normalize = text => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi');
    const table = [...document.querySelectorAll('#adminForm table')].find(candidate => {
        const headers = [...candidate.querySelectorAll('thead th')].map(th => normalize(th.textContent));
        return (headers.includes('môn thi') || headers.includes('môn học')) && headers.includes('điểm thi') && headers.includes('điểm hp');
    });
    if (!table) throw new Error('Không tìm thấy bảng điểm đúng cấu trúc (Môn thi / Điểm thi / Điểm HP).');
    const headers = table.querySelectorAll('thead th').length;
    const rows = [...table.querySelectorAll('tbody tr')];
    if (rows.some(row => row.querySelectorAll('td').length !== headers && !row.querySelector('td[colspan]'))) {
        throw new Error('Số cột của bảng điểm không khớp.');
    }
    const counter = document.querySelector('#adminForm .pagination__wrapper');
    const total = counter && counter.textContent.match(/\d+\s*[-–]\s*\d+\s*\/\s*(\d+)\s*items/i);
    if (total && rows.length !== Number(total[1])) {
        throw new Error('Bảng điểm vẫn còn phân trang, chưa lấy đủ dữ liệu.');
    }
    return table.outerHTML;
}

async function fetchGradeTable(page) {
    await page.goto(GRADES_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#adminForm #list_limit');
    const needsSubmit = await page.evaluate(() => {
        const form = document.querySelector('#adminForm');
        const limit = form.querySelector('#list_limit');
        if (![...limit.options].some(option => option.value === '0')) {
            throw new Error('Trang điểm không có tùy chọn hiển thị Tất cả.');
        }
        const fields = [...form.querySelectorAll('[name^="filter["]')];
        const offset = form.querySelector('[name="limitstart"]');
        return limit.value !== '0' || fields.some(field => field.value !== '') || (offset && offset.value !== '0');
    });
    if (needsSubmit) {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.evaluate(() => {
                const form = document.querySelector('#adminForm');
                form.querySelector('#list_limit').value = '0';
                for (const field of form.querySelectorAll('[name^="filter["]')) field.value = '';
                for (const name of ['limitstart', 'task', 'boxchecked']) {
                    const field = form.elements.namedItem(name);
                    if (field) field.value = name === 'task' ? '' : '0';
                }
                // Submit once, preserving the current session's CSRF token and learnerId.
                HTMLFormElement.prototype.submit.call(form);
            })
        ]);
    }
    await page.waitForSelector('#adminForm table');
    const complete = await page.evaluate(() => {
        const form = document.querySelector('#adminForm');
        return form.querySelector('#list_limit')?.value === '0' &&
            [...form.querySelectorAll('[name^="filter["]')].every(field => field.value === '');
    });
    if (!complete) throw new Error('Trang khảo thí chưa áp dụng hiển thị Tất cả hoặc chưa xóa bộ lọc.');
    return page.evaluate(extractGradeTable);
}

module.exports = { login, fetchGradeTable, extractGradeTable, AuthenticationError, GRADES_URL };
