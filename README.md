# Bản r2 — chẩn đoán lỗi đăng nhập trên Render

Ảnh log được cung cấp có timeout của bản cũ trước deploy. Bản đầu thiếu log các bước bên trong, nên các dòng "Khởi động trình duyệt" sau deploy không xác định được bước lỗi.

Nếu bạn đã cài bản sửa đầu, trên Render chỉ cần thay `server.js` và `school.js`, rồi commit/redeploy. Nếu dùng Vercel, thay thêm `api/index.js`. Nếu chưa cài bản đầu, làm theo phần cài đầy đủ bên dưới.

Bản r2 bổ sung:
- Log có nhãn `actvn-20261014-r2` và mã riêng cho mỗi request trên Render.
- Các bước `launch_browser`, `browser_ready`, `page_ready`, `open_school_login`, `find_microsoft_link`, `open_microsoft_login`, `wait_email_form`, `wait_password_form`, `submit_password`, `wait_school_return`, `confirm_stay_signed_in`, `login_complete`, `open_grade_page`, `wait_grade_form`, `submit_all_grades`, `extract_grade_table`, `grades_complete`.
- Lỗi trả thêm `stage` và `requestId` trong JSON trên Render, không dùng `success:false` cho lỗi tự động hóa.
- Mở rộng nhận diện xác nhận "Stay signed in"/"Duy trì đăng nhập" theo nội dung màn hình, kể cả khi không có ID Kmsi như bản trước.
- Phát hiện một số màn hình yêu cầu MFA/OTP hoặc bổ sung thông tin bảo mật để báo đúng nguyên nhân; không tự xử lý hoặc bỏ qua xác thực.
- Giới hạn chờ khởi động Chrome 30s, protocol 45s; thêm `--disable-dev-shm-usage` trên Render.
- Log chẩn đoán chỉ chứa URL bỏ query/hash và tên/loại ô nhập hiện trên màn hình. Không lưu HTML trang đăng nhập, ảnh chụp, email hoặc mật khẩu điền vào ô nhập.

Cách kiểm tra sau deploy: thực hiện lấy điểm một lần, đợi phản hồi rồi xem log mới có nhãn r2. Chụp từ `launch_browser` đến dòng lỗi hoặc `grades_complete`. Nếu vẫn thất bại, log này sẽ xác định bước và các ô nhập Microsoft đang hiện. Không thử liên tục trong lúc request trước vẫn đang chạy.

Đã qua 12 kiểm thử trình duyệt bằng trang giả lập, gồm xác nhận duy trì đăng nhập chỉ có tiêu đề và nhận diện MFA; chưa xác nhận đăng nhập thực tế trên tài khoản trường hay tài nguyên Render.

---

# API ACTVN — cập nhật trang điểm mới

API POST `/api/login` nhận JSON `{ "username": "...", "password": "..." }`.
Sau khi đăng nhập Microsoft, API mở:

https://ktdbcl.actvn.edu.vn/hvsv.html?view=learnerexams

Kết quả thành công vẫn là HTML `<table>` UTF-8, giữ nguyên các cột của trường.
Không tự tính lại điểm, bỏ môn chưa có điểm, hoặc gộp lần thi.

## Thay mã trên repository

1. Thay `server.js`, `api/index.js`, `package.json`, `package-lock.json` và thêm `school.js` ở thư mục gốc (cùng cấp `server.js`). `school.js` bắt buộc phải được đưa lên cùng mã nguồn.
2. Có thể thêm `tests/grades.test.js`, `.gitignore` và README này.
3. Giữ Dockerfile và vercel.json hiện có. Commit các thay đổi lên repository của bạn rồi redeploy dịch vụ đang chạy API.
4. Nếu chạy Node trực tiếp: `npm ci`, sau đó `npm start`. Docker đã có Chromium và biến `PUPPETEER_EXECUTABLE_PATH` như bản gốc.

Đối với Vercel, `api/index.js` nay cũng trả bảng điểm thay vì toàn bộ trang sau đăng nhập. Bổ sung dependency Chromium còn thiếu trong package gốc. Chromium trong gói này phục vụ Linux/serverless; khi kiểm thử trên Windows cần đặt `PUPPETEER_EXECUTABLE_PATH` trỏ tới Chrome/Chromium đã cài. Giới hạn thời gian/bộ nhớ của nơi triển khai vẫn có thể làm quá trình đăng nhập bị ngắt.

## Các sửa đổi

- Dùng URL mới cho trang điểm.
- Tìm đúng bảng qua tiêu đề Môn thi, Điểm thi và Điểm HP trong `#adminForm`.
- Chỉ gửi form khi cần đổi sang Tất cả (`list[limit]=0`), xóa bộ lọc hoặc đặt lại `limitstart=0`. Tránh đợi tải lại khi đã chọn Tất cả.
- Gửi form một lần, giữ CSRF token và learnerId của phiên hiện tại; không dùng giá trị từ file HTML mẫu.
- Kiểm tra lại Tất cả/bộ lọc sau khi gửi. Đối chiếu số dòng với tổng số nếu trang cung cấp bộ đếm dạng `1 - 19 / 19 items`; báo lỗi khi phát hiện kết quả chưa đầy đủ.
- Chờ trạng thái đăng nhập thay vì đăng ký chờ chuyển trang sau khi chuyển trang có thể đã xảy ra. Chỉ bấm xác nhận duy trì đăng nhập khi nhận ra màn hình này.
- Lỗi tài khoản/mật khẩu rõ ràng trả 401 `success:false`; timeout, MFA và thay đổi giao diện trả 502 `status:automation_error`, tránh tính nhầm vào bộ đếm sai mật khẩu trong PHP.
- HTML thành công có `Cache-Control: no-store`. URL debug không chứa query/hash đăng nhập.

API không tự xử lý MFA/CAPTCHA. Nếu tài khoản yêu cầu xác thực bổ sung, dùng cách đăng nhập/thêm điểm thủ công.

## PHP đọc bảng điểm

HTML bạn cung cấp có 12 cột. Nếu PHP đang dùng vị trí cột cố định, cần kiểm tra theo bảng dưới. API giữ nguyên HTML mới; không có file PHP trong repository để sửa bộ đọc đó.

| Chỉ số td (bắt đầu từ 0) | Nội dung |
| --- | --- |
| 0 | STT |
| 1 | Ô chọn (checkbox) |
| 2 | Năm học |
| 3 | Học kỳ |
| 4 | Môn thi |
| 5 | Lần |
| 6 | TP1 |
| 7 | TP2 |
| 8 | ĐQT |
| 9 | Điểm thi |
| 10 | Điểm HP |
| 11 | Điểm chữ |

Giữ điểm `0` là điểm hợp lệ, phân biệt với chuỗi rỗng (chưa có điểm).

## Kiểm tra

- Đã chạy kiểm thử trình duyệt với trang giả lập: Tất cả đã chọn, chuyển 20 → Tất cả, bộ lọc/offset còn lưu, giữ thi lại/điểm trống/điểm 0, phát hiện thiếu dòng, bảng sai, bảng rỗng, đăng nhập trực tiếp, xác nhận duy trì đăng nhập và sai mật khẩu.
- Trích xuất thành công bảng 19 dòng, 12 cột từ `index.html` người dùng cung cấp.
- Chưa kiểm chứng đăng nhập/lấy điểm trực tiếp bằng tài khoản thật, chưa triển khai lên Render/Vercel và chưa kiểm thử bộ đọc PHP bên ngoài repository.

Chạy test: `npm test` (Linux/serverless) hoặc đặt biến `PUPPETEER_EXECUTABLE_PATH` tới Chromium/Chrome để dùng trình duyệt đã cài. Các bài test chỉ dùng dữ liệu giả lập và chặn request ngoài; không đăng nhập tài khoản thật.
