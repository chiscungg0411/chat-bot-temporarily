require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const puppeteer = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = require("puppeteer-extra");

puppeteerExtra.use(StealthPlugin());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchBrowser() {
  try {
    const browser = await puppeteerExtra.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--single-process",
        "--no-zygote",
      ],
      defaultViewport: { width: 1280, height: 720 },
      timeout: 120000,
    });
    console.log("✅ Trình duyệt Puppeteer đã khởi động.");
    return browser;
  } catch (error) {
    console.error("❌ Lỗi khởi động trình duyệt:", error.message);
    throw new Error("Không thể khởi động trình duyệt.");
  }
}

async function login(page, username, password, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔑 Thử đăng nhập lần ${attempt}...`);
      await page.goto("https://portal.vhu.edu.vn/login", {
        waitUntil: "networkidle0",
        timeout: 120000,
      });
      console.log("✅ Trang đăng nhập đã tải.");

      const hasCaptcha = await page.evaluate(() => !!document.querySelector("iframe[src*='captcha']"));
      if (hasCaptcha) {
        throw new Error("Trang yêu cầu CAPTCHA, không thể đăng nhập tự động.");
      }

      await page.waitForSelector("input[name='email']", { timeout: 120000 });
      await page.type("input[name='email']", username, { delay: 100 });
      await page.waitForSelector("input[name='password']", { timeout: 120000 });
      await page.type("input[name='password']", password, { delay: 100 });
      console.log("✍️ Đã nhập thông tin đăng nhập.");

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      await page.waitForSelector("button[type='submit']", { timeout: 120000 });
      await page.click("button[type='submit']");
      console.log("⏳ Đang chờ phản hồi sau đăng nhập...");

      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 120000 });
      const finalUrl = page.url();
      console.log(`🌐 URL sau đăng nhập: ${finalUrl}`);

      if (finalUrl.includes("/login")) {
        const errorMessage = await page.evaluate(() => {
          if (document.body.innerText.includes("Username or password is incorrect")) return "Sai tên đăng nhập hoặc mật khẩu.";
          return "Đăng nhập thất bại (lỗi không xác định).";
        });
        throw new Error(`Đăng nhập thất bại: ${errorMessage}`);
      }

      console.log("✅ Đăng nhập thành công:", finalUrl);
      return true;
    } catch (error) {
      console.error(`❌ Lỗi đăng nhập lần ${attempt}:`, error.message);
      if (attempt === retries) throw new Error(`Đăng nhập thất bại sau ${retries} lần: ${error.message}`);
      console.log("⏳ Thử lại sau 5 giây...");
      await page.close();
      await delay(5000);
      page = await (await launchBrowser()).newPage();
    }
  }
}

async function getSchedule(chatId) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await login(page, process.env.VHU_EMAIL, process.env.VHU_PASSWORD);
    console.log("🏠 Điều hướng đến trang chủ sinh viên...");
    await page.goto("https://portal.vhu.edu.vn/student", {
      waitUntil: "networkidle0",
      timeout: 120000,
    });
    console.log(`🌐 URL sau khi vào trang chủ: ${page.url()}`);

    console.log("📅 Điều hướng trực tiếp đến lịch học...");
    await page.goto("https://portal.vhu.edu.vn/student/schedules", {
      waitUntil: "networkidle0",
      timeout: 120000,
    });
    console.log(`🌐 URL sau khi truy cập lịch học: ${page.url()}`);

    console.log("⏳ Đang chờ bảng lịch học tải...");
    await page.waitForSelector("#psc-table-head", { timeout: 120000 }).catch(async () => {
      const content = await page.content();
      throw new Error(`Không tìm thấy #psc-table-head. Nội dung trang: ${content.slice(0, 500)}...`);
    });

    const scheduleData = await page.evaluate(() => {
      const table = document.querySelector("#psc-table-head");
      if (!table) throw new Error("Không tìm thấy bảng lịch học!");

      const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
      const days = headers.slice(1);
      const schedule = {};
      days.forEach((day, dayIndex) => {
        schedule[day] = [];
        const cells = table.querySelectorAll(`tbody td:nth-child(${dayIndex + 2})`);
        cells.forEach((cell) => {
          const detail = cell.querySelector(".DetailSchedule");
          if (detail) {
            const spans = detail.querySelectorAll("span");
            const subjectFull = spans[1]?.textContent.trim() || "Không rõ";
            const subjectMatch = subjectFull.match(/(.*) \((.*)\)/);
            schedule[day].push({
              room: spans[0]?.textContent.trim() || "Không rõ",
              subject: subjectMatch ? subjectMatch[1] : subjectFull,
              classCode: subjectMatch ? subjectMatch[2] : "Không rõ",
              periods: spans[4]?.textContent.replace("Tiết: ", "").trim() || "Không rõ",
              startTime: spans[5]?.textContent.replace("Giờ bắt đầu: ", "").trim() || "Không rõ",
              professor: spans[6]?.textContent.replace("GV: ", "").trim() || "",
              email: spans[7]?.textContent.replace("Email: ", "").trim() || "",
            });
          }
        });
      });
      return { schedule, week: "này của bạn" };
    });

    console.log("✅ Đã lấy lịch học.");
    let message = `📅 **Lịch học tuần ${scheduleData.week}**\n------------------------------------\n`;
    let hasSchedule = false;

    for (const [ngay, monHocs] of Object.entries(scheduleData.schedule)) {
      message += `📌 **${ngay}:**\n`;
      if (monHocs.length) {
        hasSchedule = true;
        monHocs.forEach((m) => {
          message += `📖 **${m.subject} – ${m.classCode}**\n` +
                     `     (Tiết ${m.periods}, Giờ bắt đầu: ${m.startTime} – Phòng học: ${m.room}, GV: ${m.professor}, Email: ${m.email})\n`;
        });
      } else {
        message += "❌ Không có lịch\n";
      }
      message += "\n";
    }

    if (!hasSchedule) {
      message = `📅 **Lịch học tuần ${scheduleData.week}**\n------------------------------------\n❌ Không có lịch học trong tuần này.`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("❌ Lỗi trong getSchedule:", error.message);
    await bot.sendMessage(chatId, `❌ Lỗi lấy lịch học: ${error.message}`);
  } finally {
    await browser.close();
  }
}

async function getNotifications(chatId) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await login(page, process.env.VHU_EMAIL, process.env.VHU_PASSWORD);
    await page.goto("https://portal.vhu.edu.vn/student/index", { waitUntil: "networkidle0", timeout: 120000 });
    await page.waitForSelector(".MuiTableBody-root", { timeout: 120000 });
    const notifications = await page.evaluate(() => {
      const rows = document.querySelectorAll(".MuiTableBody-root tr");
      return Array.from(rows).map((row) => {
        const cols = row.querySelectorAll("td");
        return {
          MessageSubject: cols[0]?.querySelector("a")?.textContent.trim() || "Không rõ",
          SenderName: cols[1]?.textContent.trim() || "Không rõ",
          CreationDate: cols[2]?.textContent.trim() || "Không rõ",
        };
      });
    });

    let message = "📢 **Thông báo mới nhất**\n------------------------------------\n";
    if (notifications.length) {
      notifications.forEach((n) => {
        message += `📌 **${n.MessageSubject}**\n` +
                   `     (Người gửi: ${n.SenderName}, Ngày: ${n.CreationDate})\n\n`;
      });
    } else {
      message += "❌ Không có thông báo nào.\n";
    }
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("❌ Lỗi trong getNotifications:", error.message);
    await bot.sendMessage(chatId, `❌ Lỗi lấy thông báo: ${error.message}`);
  } finally {
    await browser.close();
  }
}

async function getSocialWork(chatId) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await login(page, process.env.VHU_EMAIL, process.env.VHU_PASSWORD);
    await page.goto("https://portal.vhu.edu.vn/student/congtacxahoi", { waitUntil: "networkidle0", timeout: 120000 });
    await page.waitForSelector(".MuiTableBody-root", { timeout: 120000 });
    const socialWork = await page.evaluate(() => {
      const rows = document.querySelectorAll(".MuiTableBody-root tr");
      return Array.from(rows).map((row) => {
        const cols = row.querySelectorAll("td");
        return {
          Index: cols[0]?.textContent.trim() || "Không rõ",
          Event: cols[1]?.textContent.trim() || "Không rõ",
          Location: cols[2]?.textContent.trim() || "Không rõ",
          NumRegistered: cols[3]?.textContent.trim() || "Không rõ",
          Points: cols[4]?.textContent.trim() || "0",
          StartTime: cols[5]?.textContent.trim() || "Không rõ",
          EndTime: cols[6]?.textContent.trim() || "Không rõ",
        };
      });
    });

    let message = "🤝 **Công tác xã hội**\n------------------------------------\n";
    if (socialWork.length) {
      socialWork.forEach((s) => {
        message += `📌 **${s.Event}**\n` +
                   `     (Địa điểm: ${s.Location}, Đã đăng ký: ${s.NumRegistered}, Điểm: ${s.Points})\n` +
                   `     (Bắt đầu: ${s.StartTime}, Kết thúc: ${s.EndTime})\n\n`;
      });
    } else {
      message += "❌ Không có công tác xã hội nào.\n";
    }
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("❌ Lỗi trong getSocialWork:", error.message);
    await bot.sendMessage(chatId, `❌ Lỗi lấy công tác xã hội: ${error.message}`);
  } finally {
    await browser.close();
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "👋 Xin chào! Mình là Bot hỗ trợ sinh viên VHU.\n" +
      "📅 /tuannay - Lịch học tuần này.\n" +
      "📢 /thongbao - Thông báo mới nhất.\n" +
      "🤝 /congtac - Công tác xã hội."
  );
});

bot.onText(/\/tuannay/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Đang lấy lịch học tuần này...");
  getSchedule(chatId);
});

bot.onText(/\/thongbao/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Đang lấy thông báo...");
  getNotifications(chatId);
});

bot.onText(/\/congtac/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Đang lấy danh sách công tác xã hội...");
  getSocialWork(chatId);
});

bot.on("polling_error", (error) => {
  console.error("❌ Polling error:", error.message);
});

app.get("/", (req, res) => res.send("Bot is running"));

app.listen(PORT, () => {
  console.log(`Server chạy trên port ${PORT}`);
});

console.log("🤖 Bot Telegram đang khởi động...");
console.log("✅ Bot đang chạy ở chế độ polling...");