require("dotenv").config();
const puppeteer = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = require("puppeteer-extra");

puppeteerExtra.use(StealthPlugin());

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
    console.error("❌ Lỗi khởi động trình duyệt:", error);
    throw error;
  }
}

async function login(page, username, password, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto("https://portal.vhu.edu.vn/login", {
        waitUntil: "networkidle0",
        timeout: 120000,
      });
      await page.waitForSelector("input[name='email']", { timeout: 120000 });
      await page.type("input[name='email']", username, { delay: 100 });
      await page.waitForSelector("input[name='password']", { timeout: 120000 });
      await page.type("input[name='password']", password, { delay: 100 });
      await page.waitForSelector("button[type='submit']", { timeout: 120000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0", timeout: 120000 }),
        page.click("button[type='submit']"),
      ]);
      const finalUrl = page.url();
      console.log(`🌐 URL sau đăng nhập: ${finalUrl}`);
      if (finalUrl.includes("/login")) throw new Error("Đăng nhập thất bại.");
      console.log("✅ Đăng nhập thành công!");
      return true;
    } catch (error) {
      console.error(`❌ Lỗi đăng nhập lần ${i + 1}:`, error);
      if (i === retries - 1) throw error;
      await delay(5000);
      await page.close();
      page = await (await launchBrowser()).newPage();
    }
  }
}

async function getSchedule() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await login(page, process.env.VHU_EMAIL, process.env.VHU_PASSWORD);
    await page.goto("https://portal.vhu.edu.vn/student/schedules", {
      waitUntil: "networkidle0",
      timeout: 120000,
    });
    await page.waitForSelector("#psc-table-head", { timeout: 120000 });
    const scheduleData = await page.evaluate(() => {
      const table = document.querySelector("#psc-table-head");
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
      return schedule;
    });
    console.log("✅ Lịch học:", scheduleData);
    return scheduleData;
  } catch (error) {
    console.error("❌ Lỗi trong getSchedule:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

getSchedule().catch((error) => console.error("❌ Lỗi chạy scraper:", error));