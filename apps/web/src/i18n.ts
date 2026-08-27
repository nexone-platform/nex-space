// Display language.
//
// The Thai text IS the key. Nothing here has to invent slugs, the source stays
// readable at the call site, and a phrase the dictionary has not reached yet
// falls back to Thai rather than to a bare identifier — a missing entry looks
// untranslated instead of broken.
//
// Two halves:
//   t("…")        for text built at runtime, which re-renders in the new language
//   translateDom  for the text already sitting in index.html, walked once and
//                 swapped in place; the original Thai is kept so switching back
//                 does not need a second dictionary
//
// Names people typed — display names, workspace names, guest passes — are data
// and never pass through here.

export type Lang = "th" | "en";

const LANG_KEY = "nexspace-lang";
export const LANGS: Lang[] = ["th", "en"];

export const lang = (): Lang => {
  try {
    const v = localStorage.getItem(LANG_KEY) as Lang | null;
    return v && LANGS.includes(v) ? v : "th";
  } catch { return "th"; }
};

/** for toLocaleDateString and friends, so dates follow the chosen language */
export const locale = () => (lang() === "en" ? "en-GB" : "th-TH");

const EN: Record<string, string> = {
  // ---- sign in ----
  "เข้าสู่ออฟฟิศของคุณ": "Enter your office",
  "เข้าสู่ระบบหรือสร้างบัญชีใหม่": "Sign in or create an account",
  "เข้าสู่ระบบด้วย Google": "Sign in with Google",
  "หรือ": "or",
  "อีเมลของคุณ": "Your email",
  "ส่งรหัสเข้าอีเมล": "Email me a code",
  "ข้ามไปก่อน — เข้าแบบ Guest": "Skip for now — continue as a guest",
  "กรอกรหัสของคุณ": "Enter your code",
  "ส่งรหัสอีกครั้ง": "Send another code",
  "ยกเลิก": "Cancel",
  "ยืนยัน 2 ชั้น": "Two-step verification",
  "กรอกรหัส 6 หลักจากแอป Authenticator ของคุณ": "Enter the 6-digit code from your authenticator app",
  "ยืนยันด้วยรหัสสำรอง": "Use a recovery code",
  "ทำโทรศัพท์หาย? ใช้รหัสสำรอง": "Lost your phone? Use a recovery code",
  "กลับไปใช้รหัสจากแอป": "Back to the app code",
  "กรอกรหัสสำรองที่คุณเก็บไว้ตอนเปิดใช้งาน — ใช้ได้รหัสละครั้ง":
    "Enter one of the recovery codes you saved when you turned this on — each works once",
  "รหัสสำรอง เช่น a1b2c-3d4e5": "Recovery code, e.g. a1b2c-3d4e5",
  "หมดเวลายืนยันตัวตน — เข้าสู่ระบบใหม่อีกครั้ง": "Verification timed out — please sign in again",
  "กรอกรหัสผิดหลายครั้งเกินไป — เข้าสู่ระบบใหม่อีกครั้ง": "Too many wrong codes — please sign in again",
  "(เหลือ {n} ครั้ง)": "({n} attempts left)",
  "รหัสนี้ถูกใช้ไปแล้ว — รอรหัสถัดไปในแอป": "That code has already been used — wait for the next one in your app",
  "รหัสไม่ถูกต้อง{left}": "Wrong code{left}",
  "รหัสไม่ถูกต้อง": "Wrong code",
  "รหัสหมดอายุแล้ว — ขอรหัสใหม่": "That code has expired — request a new one",
  "กรอกผิดหลายครั้งเกินไป — ขอรหัสใหม่": "Too many wrong tries — request a new code",
  "ยืนยันรหัสไม่สำเร็จ": "Could not verify the code",
  "อีเมลไม่ถูกต้อง": "That email is not valid",
  "กรอกอีเมลให้ถูกต้อง": "Enter a valid email address",
  "ส่งอีเมลไม่สำเร็จ — ตรวจการตั้งค่า SMTP": "Could not send the email — check the SMTP settings",
  "ส่งรหัสไม่สำเร็จ": "Could not send the code",
  "ส่งรหัสใหม่แล้ว": "A new code is on its way",
  "เราส่งรหัส 6 หลักไปที่ {email} แล้ว หากไม่พบให้ตรวจในกล่องสแปม":
    "We sent a 6-digit code to {email}. Check your spam folder if it does not arrive.",
  "ระบบยังไม่ได้ตั้งค่าอีเมล — ดูรหัสได้ที่ log ของเซิร์ฟเวอร์ ({email})":
    "Email is not configured yet — the code is in the server log ({email})",
  "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบว่า API ทำงานอยู่": "Cannot reach the server — check that the API is running",
  "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้": "Cannot reach the server",
  "เชื่อมต่อ API ไม่ได้": "Cannot reach the API",
  "เข้าสู่ workspace: {name}": "Signed in to {name}",
  // Google sign-in failures
  "Google ปฏิเสธการเข้าสู่ระบบ — แอปยังไม่ได้เผยแพร่ ให้เพิ่มอีเมลนี้ใน Test users หรือกด Publish app":
    "Google refused the sign-in — the app is unpublished, so add this email under Test users or publish the app",
  "ผู้ดูแล Google Workspace ขององค์กรบล็อกแอปนี้ไว้": "Your organisation's Google Workspace admin has blocked this app",
  "Redirect URI ไม่ตรงกับที่ลงทะเบียนใน Google Cloud Console":
    "The redirect URI does not match the one registered in Google Cloud Console",
  "Client ID หรือ Client secret ไม่ถูกต้อง": "The client ID or client secret is wrong",
  "รหัสจาก Google หมดอายุหรือถูกใช้แล้ว — ลองอีกครั้ง": "Google's code has expired or was already used — try again",
  "แลกโทเคนกับ Google ไม่สำเร็จ — ตรวจ Client secret": "Could not exchange the token with Google — check the client secret",
  "Google ไม่ได้ส่งรหัสยืนยันกลับมา": "Google did not return an authorisation code",
  "บัญชี Google นี้ไม่มีอีเมล": "This Google account has no email address",
  "เข้าสู่ระบบด้วย Google ไม่สำเร็จ ({reason})": "Google sign-in failed ({reason})",

  // ---- character select ----
  "เลือกตัวละคร": "Choose your character",
  "✏️ สร้างเอง": "✏️ Make your own",
  "เสื้อฟ้า": "Blue top",
  "เสื้อเขียว": "Green top",
  "เสื้อเหลือง": "Yellow top",
  "เชิ้ตขาว": "White shirt",
  "แจ็คเก็ตแดง": "Red jacket",
  "หมวกแดง": "Red cap",
  "เชิ้ตฟ้า": "Light blue shirt",
  "ชื่อในห้อง": "Name in the room",
  "เข้าห้อง": "Enter the room",
  "สวัสดี {name}": "Hello {name}",
  "โหมด Guest": "Guest mode",
  "ผู้เยี่ยมชม · {name}": "Visitor · {name}",
  "เข้าเป็นผู้เยี่ยมชม — {name}": "Enter as a visitor — {name}",
  "บัตรผู้เยี่ยมชมนี้ใช้ไม่ได้แล้ว — ขอลิงก์ใหม่จากผู้ดูแล":
    "This visitor pass is no longer valid — ask an admin for a new link",
  "ออกแบบอวาตาร์เอง": "Design your own avatar",
  "แก้ไขอวาตาร์": "Edit avatar",
  // avatar part categories — they live in the generated LPC catalogue
  "ผิว": "Skin",
  "ตา": "Eyes",
  "ผม": "Hair",
  "หนวด/เครา": "Facial hair",
  "เสื้อ": "Top",
  "แจ็กเก็ต": "Jacket",
  "กางเกง": "Bottoms",
  "รองเท้า": "Shoes",
  "หมวก": "Hat",
  "แว่น": "Glasses",
  "อื่นๆ": "Other",
  "ชาย": "Male",
  "หญิง": "Female",
  "สุ่มอวาตาร์": "Randomise",
  "เสร็จสิ้น": "Done",

  // ---- spaces dashboard ----
  "Space ของฉัน": "My spaces",
  "ค้นหา…": "Search…",
  "ค้นหา": "Search",
  "ชื่อ Space ใหม่": "New space name",
  "รหัสเชิญ": "Invite code",
  "เข้าร่วม": "Join",
  "ความปลอดภัย": "Security",
  "ออกจากระบบ": "Sign out",
  "＋ สร้าง Space": "＋ New space",
  "ไม่พบ Space ที่ค้นหา": "No spaces match your search",
  "ยังไม่มี Space — กด “＋ สร้าง Space” หรือกรอกรหัสเชิญด้านบน":
    "No spaces yet — use “＋ New space” or enter an invite code above",
  "เข้า Space นี้": "Open this space",
  "· {n} คน": "· {n} members",
  "ตั้งค่า / สมาชิก": "Settings / members",
  "โหลดรายการ Space ไม่ได้": "Could not load your spaces",
  "ใส่ชื่อ Space ก่อน": "Give the space a name first",
  "สร้างไม่สำเร็จ": "Could not create it",
  "ใส่รหัสเชิญก่อน": "Enter an invite code first",
  "ไม่พบรหัสเชิญนี้": "No space matches that invite code",
  "เข้าร่วมไม่สำเร็จ": "Could not join",
  "ลิงก์: ?w={slug}": "Link: ?w={slug}",

  // ---- create-space wizard ----
  "เริ่มต้นใช้งาน": "Get started",
  "← ย้อนกลับ": "← Back",
  "ถัดไป →": "Next →",
  "บทบาทของคุณตรงกับข้อไหนมากที่สุด?": "Which best describes your role?",
  "ผู้ก่อตั้ง": "Founder",
  "ผู้บริหาร": "Executive",
  "ผู้อำนวยการ": "Director",
  "ผู้จัดการ": "Manager",
  "สมาชิกทีม": "Team member",
  "บริษัทของคุณมีขนาดเท่าไหร่?": "How big is your company?",
  "คุณจะใช้ออฟฟิศเสมือนนี้เป็นหลักอย่างไร?": "How will you mainly use this virtual office?",
  "พื้นที่ทำงานประจำวันของทีม": "A daily workspace for the team",
  "พื้นที่ทำงานสัปดาห์ละ 1-2 ครั้ง": "A workspace once or twice a week",
  "อีเวนต์ครั้งเดียว (เช่น Hackathon)": "A one-off event (a hackathon, say)",
  "อีเวนต์ประจำ (เช่น Workshop)": "A recurring event (a workshop, say)",
  "อื่น ๆ (ระบุ)": "Something else (tell us)",
  "อื่น ๆ": "Other",
  "ระบุเพิ่มเติม…": "Tell us more…",
  "เลือกแผนผังออฟฟิศของคุณ": "Choose your office layout",
  "ทุกคนใน Space จะใช้แผนผังนี้ร่วมกัน และเลือกได้เฉพาะตอนสร้างเท่านั้น":
    "Everyone in the space shares this layout, and it can only be chosen now",
  "ตั้งชื่อ Space ของคุณ": "Name your space",
  "เช่น บริษัท A": "e.g. Acme Ltd",
  "สร้าง Space": "Create space",

  // ---- workspace settings (dashboard dialog) ----
  "ตั้งค่า Workspace": "Workspace settings",
  "ชื่อบริษัท / ทีม": "Company / team name",
  "ให้คนที่ไม่ได้สมัครสมาชิก (Guest) เข้าได้": "Let people without an account (guests) in",
  "ลิงก์เชิญ": "Invite link",
  "คัดลอก": "Copy",
  "คัดลอกแล้ว": "Copied",
  "รีเซ็ต": "Reset",
  "สร้างรหัสใหม่ ลิงก์เดิมจะใช้ไม่ได้": "Issue a new code; the old link stops working",
  "สมาชิกและสิทธิ์ (": "Members and permissions (",
  "ออกจาก Workspace": "Leave workspace",
  "ปิด": "Close",
  "บันทึก": "Save",
  "บันทึกแล้ว": "Saved",
  "บันทึกไม่สำเร็จ": "Could not save",
  "สร้างรหัสเชิญใหม่? ลิงก์เดิมจะใช้ไม่ได้": "Issue a new invite code? The old link stops working.",
  "สร้างรหัสเชิญใหม่? ลิงก์เดิมที่แจกไปแล้วจะใช้ไม่ได้":
    "Issue a new invite code? Links you have already handed out stop working.",
  "สร้างรหัสเชิญใหม่แล้ว": "New invite code issued",
  "รีเซ็ตไม่สำเร็จ": "Could not reset it",
  "คุณไม่มีสิทธิ์รีเซ็ตลิงก์เชิญ": "You may not reset the invite link",
  "คุณไม่มีสิทธิ์แก้ไข Space นี้": "You may not edit this space",
  "ออกจาก workspace นี้?": "Leave this workspace?",
  "เจ้าของออกเองไม่ได้": "An owner cannot leave their own workspace",
  "ออกไม่สำเร็จ": "Could not leave",

  // ---- two-factor setup ----
  "ยืนยันตัวตน 2 ชั้น": "Two-factor authentication",
  "ยืนยันตัวตน 2 ชั้น (2FA)": "Two-factor authentication (2FA)",
  "ขอรหัส 6 หลักจากแอป Authenticator เพิ่มทุกครั้งที่เข้าสู่ระบบ":
    "Ask for a 6-digit code from your authenticator app every time you sign in",
  "● ยังไม่ได้เปิดใช้งาน": "● Off",
  "● เปิดใช้งานอยู่": "● On",
  "ใช้ได้กับ Google Authenticator, Microsoft Authenticator, Authy, 1Password และแอปอื่นที่รองรับมาตรฐาน TOTP":
    "Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password and anything else that supports TOTP",
  "เปิดแอป Authenticator แล้วสแกน QR นี้": "Open your authenticator app and scan this QR code",
  "กรอกรหัส 6 หลักที่แอปแสดงเพื่อยืนยัน": "Enter the 6-digit code it shows to confirm",
  "สแกนไม่ได้? ใส่รหัสนี้ในแอปด้วยมือ": "Cannot scan? Type this key into the app instead",
  "QR code สำหรับแอป Authenticator": "QR code for your authenticator app",
  "รหัสจากแอป": "Code from the app",
  "เก็บรหัสสำรองนี้ไว้ในที่ปลอดภัย ใช้ได้รหัสละ 1 ครั้ง สำหรับตอนที่ไม่มีโทรศัพท์ —":
    "Keep these recovery codes somewhere safe. Each works once, for when you do not have your phone —",
  "จะแสดงเพียงครั้งเดียวเท่านั้น": "this is the only time they are shown",
  "คัดลอกทั้งหมด": "Copy all",
  "ดาวน์โหลด .txt": "Download .txt",
  "เหลือรหัสสำรอง": "Recovery codes left:",
  "รหัส": "codes",
  "กรอกรหัสจากแอป (หรือรหัสสำรอง) เพื่อยืนยันว่าเป็นคุณ":
    "Enter a code from the app (or a recovery code) to prove it is you",
  "ปิดใช้งาน": "Turn off",
  "ออกรหัสสำรองใหม่": "Issue new recovery codes",
  "เปิดใช้งาน": "Turn on",
  "ยืนยัน": "Confirm",
  "เปิดใช้งานอยู่แล้ว": "Already on",
  "เริ่มขั้นตอนตั้งค่าใหม่อีกครั้ง": "Start the setup again",
  "กรอกรหัสเพื่อยืนยัน": "Enter the code to confirm",
  "คัดลอกรหัสแล้ว": "Key copied",
  "คัดลอกรหัสสำรองแล้ว": "Recovery codes copied",
  "รหัสสำรอง NexSpace — {email}": "NexSpace recovery codes — {email}",
  "ใช้ได้รหัสละ 1 ครั้ง เมื่อไม่มีแอป Authenticator": "Each code works once, for when you do not have your authenticator app",

  // ---- settings modal ----
  "การตั้งค่า": "Settings",
  "ตั้งค่า": "Settings",
  "ทั่วไป": "General",
  "เครดิตงานศิลป์": "Art credits",
  "ออฟฟิศ": "Office",
  "จัดการสมาชิก": "Manage members",
  "จัดการแขก": "Manage guests",
  "รายชื่อสมาชิก (": "Members (",
  "คำเชิญ (0)": "Invitations (0)",
  "คำเชิญที่รอตอบรับ — เร็ว ๆ นี้": "Pending invitations — coming soon",
  "ภาษา": "Language",
  "ภาษาที่แสดง": "Display language",
  "เลือกภาษาที่ใช้ใน NexSpace": "Choose the language NexSpace uses",
  "ไทย": "Thai",
  "รูปลักษณ์": "Appearance",
  "โหมดสี": "Colour mode",
  "เบต้า": "beta",
  "เลือกระหว่างโหมดสว่าง โหมดมืด หรือให้ตรงกับการตั้งค่าระบบของคุณ — แผนที่ในห้องเป็นพิกเซลอาร์ต จึงคงสีเดิมไว้":
    "Choose light, dark, or match your system — the map itself is pixel art, so it keeps its own colours",
  "สว่าง": "Light",
  "มืด": "Dark",
  "ตรงกับระบบ": "Match system",
  "Space นี้": "This space",
  "ธีมแผนผังออฟฟิศ": "Office layout theme",
  "เลือกได้ตอนสร้าง Space เท่านั้น — ทุกคนต้องอยู่บนแผนผังเดียวกัน การเปลี่ยนภายหลังจะยกเลิกโต๊ะที่ทุกคนจองไว้":
    "Chosen when the space is created — everyone has to be on the same layout, and changing it would cancel every desk the team has claimed",
  "กำลังดูตัวอย่างธีม \"{theme}\" จาก URL — ไม่ใช่ธีมที่ Space นี้ใช้จริง":
    "Previewing the \"{theme}\" theme from the URL — this is not the theme the space actually uses",
  "โหลดการตั้งค่าไม่ได้": "Could not load the settings",
  "ต้องเป็นเจ้าของหรือผู้ดูแลจึงจะแก้ไขการตั้งค่าของ Space ได้":
    "Only an owner or admin can change a space's settings",
  "พื้นที่สาธารณะนี้ไม่มีการตั้งค่าให้แก้ไข": "This public space has no settings to change",
  "พื้นที่สาธารณะนี้เข้าได้ทุกคน ไม่มีการกำหนดสิทธิ์ — สร้าง Space ของทีมเพื่อจัดการสมาชิก":
    "This public space is open to everyone and has no permissions — create a team space to manage members",
  "พื้นที่สาธารณะนี้เข้าได้ทุกคนอยู่แล้ว จึงไม่มีบัตรผู้เยี่ยมชม — สร้าง Space ของทีมเพื่อคุมทางเข้า":
    "This public space is already open to everyone, so there are no visitor passes — create a team space to control the door",
  "คัดลอกลิงก์เชิญแล้ว — ส่งให้เพื่อนร่วมงานได้เลย": "Invite link copied — send it to your colleagues",

  // ---- art credits ----
  "งานศิลป์บางส่วนมาจากศิลปินภายนอกภายใต้สัญญาอนุญาตที่": "Some of the art comes from outside artists under licences that",
  "กำหนดให้ต้องแสดงเครดิต": "require attribution",
  "ทุกที่ที่เผยแพร่งาน หน้านี้คือเครดิตนั้น": "wherever the work is published. This page is that attribution.",
  "ศิลปิน": "Artists",
  "สัญญาอนุญาต": "Licence",
  "แหล่งที่มา": "Source",
  "รายการครบทุกชิ้น": "Full list",
  "ธีม \"ออฟฟิศคลาสสิก\" — เฟอร์นิเจอร์และของตกแต่ง": "\"Classic office\" theme — furniture and props",
  "โต๊ะ ตู้ แล็ปท็อป แก้วกาแฟ เครื่องถ่ายเอกสาร ตู้กดน้ำ ทีวี และภาพติดผนัง (LPC \"The Office\")":
    "Desks, cabinets, laptops, coffee mugs, a copier, a water cooler, a TV and wall art (LPC \"The Office\")",
  "ต้นฉบับ (GitHub)": "Upstream (GitHub)",
  "ข้อความสัญญาอนุญาต OGA-BY 3.0": "OGA-BY 3.0 licence text",
  "ธีม \"ออฟฟิศคลาสสิก\" — โต๊ะทำงาน เก้าอี้ และคอมพิวเตอร์": "\"Classic office\" theme — desks, chairs and computers",
  "ตัดจาก CoolSchool tileset (48px วางขนาดจริง)": "Cut from the CoolSchool tileset (48px, placed at native size)",
  "ตัวละครและชุดแต่งตัว (ทุกธีม)": "Characters and clothing (every theme)",
  "ชิ้นส่วนอวาตาร์ 749 รายการจากโครงการ Universal LPC Spritesheet":
    "749 avatar parts from the Universal LPC Spritesheet project",
  "แผนผัง พื้น กำแพง และของตกแต่งอื่น ๆ": "Layouts, floors, walls and the remaining props",
  "สร้างขึ้นสำหรับ NexSpace ด้วย PixelLab": "Made for NexSpace with PixelLab",

  // ---- member panel ----
  "เจ้าของ": "Owner",
  "ผู้ดูแล": "Admin",
  "สมาชิก": "Member",
  "ผู้เยี่ยมชม": "Visitor",
  "ชื่อ": "Name",
  "สิทธิ์": "Role",
  "ใช้งานล่าสุด": "Last active",
  "ทุกสิทธิ์": "All roles",
  "ค้นหาชื่อหรืออีเมล…": "Search name or email…",
  "เชิญคนเข้า workspace": "Invite someone to the workspace",
  "ยังไม่เคยเข้า": "Never",
  "กำลังใช้งาน": "Active now",
  "{n} นาทีที่แล้ว": "{n} min ago",
  "{n} ชม.ที่แล้ว": "{n} hr ago",
  "{n} วันที่แล้ว": "{n} days ago",
  "คุณไม่มีสิทธิ์ทำรายการนี้": "You may not do that",
  "เปลี่ยนสิทธิ์เจ้าของไม่ได้": "The owner's role cannot be changed",
  "เปลี่ยนสิทธิ์ของตัวเองไม่ได้": "You cannot change your own role",
  "นำเจ้าของออกไม่ได้": "The owner cannot be removed",
  "คนนี้ไม่ได้อยู่ใน workspace แล้ว": "They are no longer in this workspace",
  "ทำรายการไม่สำเร็จ": "That did not work",
  "{name} เป็น{role}แล้ว": "{name} is now {role}",
  "นำ {name} ออกจาก workspace?": "Remove {name} from the workspace?",
  "นำ {name} ออกแล้ว": "{name} removed",
  "ตั้งเป็นผู้ดูแล": "Make admin",
  "ถอดสิทธิ์ผู้ดูแล": "Remove admin",
  "ตั้งเป็นสมาชิก": "Make member",
  "ลดเป็นผู้เยี่ยมชม": "Demote to visitor",
  "นำออกจาก Workspace": "Remove from workspace",
  "ไม่พบสมาชิกที่ตรงกับการค้นหา": "No members match your search",
  "ยังไม่มีสมาชิก": "No members yet",
  "(คุณ)": "(you)",
  "คุณ": "you",
  "ก่อนหน้านี้": "earlier",
  "ออนไลน์": "Online",
  "แชร์ลิงก์ให้เพื่อนร่วมงาน": "Share the link with a colleague",
  "นี่คือบัญชีของคุณเอง — ส่งข้อความหาตัวเองไม่ได้": "That is your own account — you cannot message yourself",
  "โบกมือตอบ": "Wave back",
  "เดินไปหา": "Walk over",
  "ไว้ก่อน": "Not now",
  "ตอนนี้": "Just now",
  "ตอนนี้ • จากโต๊ะของ {name}": "Just now • from {name}'s desk",
  "โบกมือ": "Wave",
  "ไปที่": "Go there",
  "ส่งข้อความ": "Message",
  "{name} โบกมือให้คุณ": "{name} waved at you",
  "โบกมือให้ {name} แล้ว": "Waved at {name}",
  "ไปหา": "Go to them",
  "ห้ามรบกวน": "Do not disturb",
  "ห้ามรบกวน — ปิดเสียงคนรอบตัวและเสียงแจ้งเตือน": "Do not disturb — silences the people around you and the alerts",
  "ห้ามรบกวน — ไม่ได้ยินเสียงรอบตัวและไม่มีเสียงแจ้งเตือน": "Do not disturb — you will not hear the room or any alerts",
  "กลับมารับเสียงตามปกติแล้ว": "Back to hearing the room",
  "{name} กำลังห้ามรบกวน — ลองส่งข้อความแทน": "{name} is on do not disturb — try a message instead",
  "การแจ้งเตือน": "Notifications",
  "ล่าสุด": "Recent",
  "ล้าง": "Clear",
  "ยังไม่มีอะไรพลาดไป": "Nothing missed",
  "เสียงแจ้งเตือน": "Notification sound",
  "ข้อความจาก {name}": "Message from {name}",
  "ข้อความ": "Message",
  "ตามตัว": "Find",
  "เรียกมาหา": "Ask over",
  "ตำแหน่ง": "Role",
  "ทีม": "Team",
  "เวลาท้องถิ่น": "Local time",
  "ชื่อที่แสดง": "Display name",
  "ทีม / แผนก": "Team or department",
  "เขตเวลา": "Time zone",
  "แนะนำตัว": "About",
  "เช่น ฝ่ายพัฒนา": "e.g. Engineering",
  "ทำอะไรอยู่ ติดต่อเรื่องอะไรได้บ้าง": "What you work on, and what to come to you about",
  "บันทึกโปรไฟล์แล้ว": "Profile saved",
  "หาไม่เจอ — เขาอาจออกไปแล้ว": "Cannot find them — they may have left",
  "กำลังตามดู {name} — เดินเมื่อไหร่กล้องกลับมาเอง": "Watching {name} — the camera returns the moment you move",
  "เรียก {name} มาแล้ว": "Asked {name} to come over",
  "{name} เรียกให้ไปหา": "{name} would like you to come over",
  "เพิ่งเรียก {name} ไปเมื่อครู่ — รออีก {n} วิ":
    "You just asked {name} over — {n}s to go",
  "ข้อความส่วนตัว": "Direct messages",
  "ส่งข้อความส่วนตัว": "Send a direct message",
  "ส่งข้อความส่วนตัว…": "Send a direct message…",
  "ยังไม่มีข้อความส่วนตัว — เริ่มได้จากรายชื่อคน": "No direct messages yet — start one from the people list",
  "ยังไม่มีข้อความในนี้": "Nothing here yet",
  "กลับไปที่รายการ": "Back to the list",
  "เข้าร่วมเมื่อ {date}": "Joined {date}",
  "ตัวเลือก": "Options",
  "เข้าสู่ระบบเพื่อดูและจัดการสมาชิก": "Sign in to see and manage members",
  "คุณไม่ได้เป็นสมาชิกของ workspace นี้": "You are not a member of this workspace",
  "ไม่พบ workspace นี้": "No such workspace",
  "โหลดสมาชิกไม่ได้": "Could not load the members",

  // ---- guest passes ----
  "บัตรผู้เยี่ยมชมคือลิงก์สำหรับคนนอกทีมหนึ่งคน — ระบุชื่อได้ กำหนดวันหมดอายุได้ และเพิกถอนเฉพาะคนนั้นได้ โดยไม่กระทบสมาชิกหรือแขกคนอื่น":
    "A visitor pass is a link for one person outside the team — it carries their name, can expire, and can be revoked on its own without affecting anyone else",
  "ทั้งหมด": "All",
  "ใช้งานอยู่": "Active",
  "หมดอายุแล้ว": "Expired",
  "ถูกเพิกถอน": "Revoked",
  "ถูกเพิกถอนแล้ว": "Revoked",
  "เก็บถาวรแล้ว": "Archived",
  "1 วัน": "1 day",
  "7 วัน": "7 days",
  "30 วัน": "30 days",
  "90 วัน": "90 days",
  "ไม่มีวันหมดอายุ": "Never expires",
  "หมดอายุ {date}": "Expired {date}",
  "เหลือ {n} ชม.": "{n} hr left",
  "เหลือ {n} วัน": "{n} days left",
  "เชิญผู้เยี่ยมชมใหม่": "Invite a visitor",
  "ต้องเป็นเจ้าของหรือผู้ดูแลจึงจะจัดการผู้เยี่ยมชมได้": "Only an owner or admin can manage visitors",
  "ไม่พบบัตรผู้เยี่ยมชมนี้": "No such visitor pass",
  "กรอกชื่อผู้เยี่ยมชมก่อน": "Enter the visitor's name first",
  "คัดลอกลิงก์ของ {name} แล้ว": "Copied {name}'s link",
  "ชื่อผู้เยี่ยมชม เช่น คุณสมชาย (ลูกค้า)": "Visitor's name, e.g. Alex Chen (client)",
  "สร้างลิงก์": "Create link",
  "Space นี้เปิดให้ผู้เยี่ยมชมเข้าได้อยู่แล้ว — บัตรยังมีประโยชน์เพราะระบุชื่อผู้มาเยี่ยม บันทึกการเข้า และเพิกถอนรายคนได้":
    "This space already lets visitors in — a pass still earns its keep: it names the visitor, records their visits, and can be revoked one at a time",
  "Space นี้ปิดรับผู้เยี่ยมชม — คนที่ได้รับบัตรนี้จะเข้าได้เฉพาะคนเดียว ตามอายุบัตรที่กำหนด":
    "This space is closed to visitors — only the person holding this pass gets in, for as long as it lasts",
  "สร้างบัตรของ {name} แล้ว": "Created a pass for {name}",
  "เอาออกจากที่เก็บถาวร": "Restore from archive",
  "กู้คืนบัตรของ {name} แล้ว": "Restored {name}'s pass",
  "คัดลอกลิงก์เชิญ": "Copy invite link",
  "คืนสิทธิ์เข้าใช้งาน": "Restore access",
  "คืนสิทธิ์ {name} แล้ว": "Restored access for {name}",
  "ต่ออายุ {n} วัน": "Extend by {n} days",
  "ต่ออายุบัตรของ {name} อีก {n} วัน": "Extended {name}'s pass by {n} days",
  "เพิกถอนบัตร": "Revoke pass",
  "เพิกถอนบัตรของ {name}? ลิงก์เดิมจะใช้เข้าไม่ได้ทันที": "Revoke {name}'s pass? Their link stops working immediately.",
  "เพิกถอนบัตรของ {name} แล้ว": "Revoked {name}'s pass",
  "เก็บถาวร": "Archive",
  "เก็บถาวรบัตรของ {name} แล้ว": "Archived {name}'s pass",
  "ไม่พบผู้เยี่ยมชม": "No visitors found",
  "ยังไม่มีผู้เยี่ยมชม — กดปุ่มขวาบนเพื่อสร้างลิงก์เชิญ": "No visitors yet — use the button top right to create an invite link",
  "{until} · เข้ามาแล้ว {n} ครั้ง": "{until} · {n} visits",
  "{until} · ยังไม่เคยเข้า": "{until} · never used",
  "สร้างเมื่อ {date}": "Created {date}",
  "เข้าสู่ระบบเพื่อจัดการผู้เยี่ยมชม": "Sign in to manage visitors",
  "ไม่พบ Space นี้": "No such space",
  "โหลดรายชื่อผู้เยี่ยมชมไม่ได้": "Could not load the visitors",

  // ---- in the room ----
  "เดิน:": "Move:",
  "/ลูกศร · เก้าอี้: คลิก+ลาก=หมุน ·": "/arrows · Chairs: click+drag to turn ·",
  // Thai joins straight onto the <b>Enter</b> with "="; English needs the space,
  // and the node itself has none to keep
  "=แชตกับคนที่อยู่ใกล้ · NexSpace": " to chat with people nearby · NexSpace",
  "ชวนเพื่อนเข้าห้อง": "Invite people in",
  "＋ เชิญ / คัดลอกลิงก์": "＋ Invite / copy link",
  "✓ คัดลอกลิงก์แล้ว!": "✓ Link copied!",
  "ค้นหาคน…": "Search people…",
  "ยังไม่มีข้อความ — ทักทายทั้งห้องได้เลย 👋": "No messages yet — say hello to the room 👋",
  "ส่งข้อความถึงทั้งห้อง…": "Message the whole room…",
  "พิมพ์แล้ว Enter เพื่อคุยกับคนใกล้ ๆ…": "Type, then Enter to talk to people nearby…",
  "ส่ง": "Send",
  "แชตห้อง": "Room chat",
  "แชตห้องรวม": "Room chat",
  "ห้องประชุม": "Meeting room",

  // ---- roles: what each may see and do ----
  "เชิญออกจากพื้นที่": "Remove from the space",
  "เชิญ {name} ออกจากพื้นที่นี้?": "Remove {name} from this space?",
  "เชิญ {name} ออกแล้ว — เขากลับเข้ามาได้ถ้ายังมีสิทธิ์เข้า": "{name} was removed — they can come back if they still have a way in",
  "{name} เชิญคุณออกจากพื้นที่นี้": "{name} removed you from this space",
  "คุณถูกเชิญออกจากพื้นที่นี้": "You were removed from this space",
  // ---- the one character on the picker ----
  "✏️ แต่งตัวละคร": "✏️ Dress your character",
  "แตะเพื่อเลือกผม เสื้อผ้า และสีที่ชอบ": "Tap to pick the hair, the clothes and the colours you want",
  "ตัวละครของคุณ": "Your character",

  // ---- gestures and stickers (P2-10) ----
  "พูดออกไป": "Say it",
  "ท่าทาง": "Gestures",
  "สติกเกอร์ — เลือกแล้วคลิกบนพื้น": "Stickers — pick one, then click the floor",
  "คลิกบนพื้นเพื่อวางสติกเกอร์": "Click the floor to leave the sticker",
  "เต้น": "Dance",
  "ปรบมือ": "Clap",
  "ยกนิ้วให้": "Thumbs up",
  "ฉลอง": "Celebrate",
  "กำลังคิด": "Thinking",

  // ---- the admin dashboard (admin.html) ----
  "แดชบอร์ดผู้ดูแล": "Admin dashboard",
  "← กลับไปที่ Space": "← Back to the space",
  "📊 แดชบอร์ดการใช้งาน": "📊 Usage dashboard",
  "การใช้งานรายวัน": "Use, day by day",
  "รวมเวลาที่ทุกคนอยู่ในพื้นที่ แยกตามวัน": "Everyone's time in the space, totalled per day",
  "ช่วงเวลาที่คนอยู่มากที่สุด": "When the office is busiest",
  "รวมเวลาทั้งช่วง แยกตามชั่วโมงของวัน — เวลาของเซิร์ฟเวอร์": "The whole period, totalled by hour of day — in the server's time",
  "ห้องที่ถูกใช้มากที่สุด": "The rooms people use",
  "เวลาที่คนยืนอยู่ในแต่ละโซน รวมทุกคน": "Time spent standing in each area, everybody together",
  "รายคน": "Person by person",
  "เรียงตามเวลารวมที่อยู่ในพื้นที่": "Ordered by total time in the space",
  "คนที่เข้ามา": "People",
  "การเข้าใช้": "Visits",
  "เวลารวม": "Total time",
  "เฉลี่ยต่อครั้ง": "Average visit",
  "ในช่วง {n} วัน": "over {n} days",
  "{n} ครั้งยังอยู่ในห้อง": "{n} still in the room",
  "จบแล้วทุกครั้ง": "all of them finished",
  "นับเฉพาะครั้งที่จบแล้ว": "finished visits only",
  "วันที่ใช้มากสุด {day}": "busiest on {day}",
  "{n} นาที": "{n} min",
  "{n} ชม.": "{n} h",
  "{h} ชม. {m} นาที": "{h} h {m} min",
  "{n} ครั้ง": "{n} visits",
  "{n} วัน": "{n} days",
  "ชั่วโมง": "Hours",
  "ชั่วโมงรวม": "Total hours",
  "วัน": "Day",
  "คน": "People",
  "มาล่าสุด": "Last seen",
  "แขก": "guest",
  "พื้นที่เปิด · {map}": "Open floor · {map}",
  "ดูเป็นตาราง": "See the numbers",
  "ยังไม่มีข้อมูลในช่วงนี้": "Nothing recorded in this period",
  "ต้องเป็นเจ้าของหรือผู้ดูแล": "Owners and admins only",
  "แดชบอร์ดนี้แสดงว่าใครอยู่ที่ไหนนานเท่าไร จึงเปิดให้เฉพาะเจ้าของพื้นที่และผู้ดูแล": "This dashboard shows who was where and for how long, so it is for the space's owners and admins",
  "แดชบอร์ดนี้เปิดให้เฉพาะเจ้าของพื้นที่และผู้ดูแล เข้าสู่ระบบที่หน้าหลักก่อนแล้วกลับมาที่ลิงก์นี้อีกครั้ง": "This dashboard is for owners and admins. Sign in on the main page, then come back to this link.",
  "โหลดข้อมูลไม่ได้": "Could not load the numbers",
  "ไม่มีพื้นที่ชื่อ \"{slug}\" — เปิดหน้านี้จากลิงก์ที่มี ?w=<slug> ของพื้นที่ที่ต้องการดู": "There is no space called \"{slug}\" — open this page from a link carrying the ?w=<slug> of the space you mean",
  // ---- locked rooms and knocking (P2-5) ----
  "ล็อกอยู่ — ต้องมีคนข้างในเปิดให้": "Locked — somebody inside has to let you in",
  "เปิดให้ทุกคนเดินเข้าได้": "Open — anybody may walk in",
  "{area} ล็อกอยู่": "{area} is locked",
  "เคาะประตูเพื่อขอเข้า": "Knock to ask to come in",
  "เคาะประตู": "Knock",
  "{name} เคาะประตู {area}": "{name} is knocking at {area}",
  "เปิดให้เข้า": "Let them in",
  "ยังไม่สะดวก": "Not right now",
  "เปิดให้เข้าได้จากการ์ดนี้": "You can let them in from this card",
  "{name} ยังไม่สะดวก": "{name} is not free right now",
  "{name} เปิดให้เข้า {area}": "{name} let you into {area}",
  "เคาะแล้ว — รออีก {n} คนในห้องรับ": "Knocked — waiting for {n} inside to answer",
  "กำลังไป {name}": "Heading to {name}",

  // ---- the map editor (editor.html) ----
  "ตัดเสียงรบกวนและเสียงสะท้อน": "Cut background noise and echo",
  "ตัดเสียงพัดลม เสียงพิมพ์ และเสียงก้องจากลำโพง พร้อมปรับความดังให้สม่ำเสมอ — ปิดถ้าจะเล่นดนตรีหรือใช้ไมค์ที่มีตัวประมวลผลของตัวเองอยู่แล้ว": "Cuts fan noise, typing and speaker echo, and evens out the volume — turn it off to play music, or for a microphone that already does its own processing",
  "เปิด": "On",
  "ฝังหน้าเว็บ": "Embedded page",
  "ที่อยู่เว็บที่จะเปิด": "The page it opens",
  "กด E ตอนยืนข้าง ๆ เพื่อเปิด": "Stand next to it and press E to open",
  "ต้องเป็น https:// — วางแบบอื่นไม่ได้ เพราะหน้านี้ถูกเปิดในเฟรมบนโดเมนของเรา": "Must be https:// — anything else is refused, because the page is opened in a frame on our own domain",
  "ต้องใส่ที่อยู่ https:// ก่อนวางวัตถุนี้": "Enter an https:// address before placing this object",
  "ย้ายมาก่อนหน้า": "Move earlier",
  "ย้ายไปถัดไป": "Move later",
  "ลบแผนที่นี้": "Delete this map",
  "คนเข้ามาเจอชั้นนี้": "people land here",
  "เรียงลำดับไม่สำเร็จ": "Could not reorder",
  "ลบ \"{name}\" ทิ้งถาวร? ทุกอย่างที่วางไว้บนแผนที่นี้จะหายไปด้วย": "Delete \"{name}\" for good? Everything placed on this map goes with it",
  "แผนที่ใหม่": "New map",
  "ชื่อแผนที่ใหม่": "Name of the new map",
  "ชั้นใหม่": "New floor",
  "แผนที่นี้": "This map",
  "ไม่พบแผนที่นี้": "No such map",
  "พื้นที่นี้ไม่มีแผนที่ชื่อ \"{slug}\" — อาจถูกลบไปแล้ว": "This space has no map called \"{slug}\" — it may have been deleted",
  "ไปที่แผนที่": "Leads to map",
  "เว้นช่องว่างไว้เพื่อไปโผล่ที่จุดเกิดของแผนที่ปลายทาง": "Leave these blank to arrive at that map's own spawn",
  "ประตูมิติในแผนที่เดียวกันต้องระบุช่องปลายทาง": "A portal inside one map needs a destination tile",
  "โต๊ะ": "Desks",
  "โซนส่วนตัว": "Private areas",
  "วัตถุโต้ตอบ": "Interactive objects",
  "ลบ": "Delete",
  "แก้ไขแผนที่": "Edit map",
  "ชื่อแผนที่": "Map name",
  "เลิกทำ (Ctrl+Z)": "Undo (Ctrl+Z)",
  "ทำซ้ำ (Ctrl+Shift+Z)": "Redo (Ctrl+Shift+Z)",
  "คืนค่าแผนที่สำเร็จรูป": "Back to the stock map",
  "เครื่องมือ": "Tools",
  "ขนาดแผนที่": "Map size",
  "กว้าง": "Width",
  "สูง": "Height",
  "ย่อแผนที่แล้วของที่อยู่นอกขอบใหม่จะถูกลบ": "Shrinking the map deletes anything left outside it",
  "มุมมอง": "View",
  "เส้นตาราง": "Grid",
  "หมุด": "Pins",
  "ซูม": "Zoom",
  "ยืนในโซนเดียวกันคือได้ยินกันหมด และคนนอกไม่ได้ยินเลย · โซนที่มีขอบเน้นคือห้องประชุม": "Everyone in the same area hears each other, and nobody outside does · the outlined one is the meeting room",
  "← กลับไปที่ NexSpace": "← Back to NexSpace",
  "พื้น": "Floor",
  "กำแพง": "Walls",
  "พร็อพ": "Props",
  "โซน": "Area",
  "จุดเกิด": "Spawn",
  "วัตถุ": "Object",
  "ครีม": "Cream",
  "หญ้า": "Grass",
  "ไม้": "Wood",
  "ชมพู": "Pink",
  "มินต์": "Mint",
  "ฟ้า": "Blue",
  "ไม้เข้ม": "Dark wood",
  "ทางเดิน": "Path",
  "อิฐ": "Brick",
  "เฟอร์นิเจอร์": "Furniture",
  "ของแขวนผนัง": "Wall decor",
  "กลางแจ้ง": "Outdoor",
  "ลากเพื่อทาหลายช่อง": "Drag to paint several tiles",
  "คลิกหรือลากเพื่อวางกำแพง · กด Alt ค้างไว้เพื่อลบ · ลายกำแพงต่อกันเองอัตโนมัติ": "Click or drag to build · hold Alt to remove · wall tiles join up on their own",
  "โต๊ะที่จะวาง": "Desk to place",
  "ไม่พบพร็อพที่ค้นหา": "No props match that",
  "เดินทะลุไม่ได้": "Blocks movement",
  "ขนาด": "Size",
  "เต็ม": "Full",
  "ครึ่ง": "Half",
  "วางโต๊ะที่จองได้ ที่นั่งจะอยู่ช่องถัดลงมาหนึ่งช่อง": "Places a claimable desk; the seat is the tile below it",
  "ลากคลุมพื้นที่เพื่อสร้างโซน · ตั้งชื่อได้จากรายการทางขวา": "Drag out a rectangle to make an area · name it from the list on the right",
  "คลิกช่องที่คนเข้าห้องใหม่จะยืน · ต้องไม่ใช่กำแพง": "Click where new arrivals stand · not on a wall",
  "ยืนข้างวัตถุแล้วกด E เพื่อใช้งาน": "Stand next to it and press E to use it",
  "ลบสิ่งที่อยู่บนสุดของช่องนั้น: วัตถุ → โต๊ะ → พร็อพ → กำแพง · โซนลบได้จากรายการทางขวา": "Removes the topmost thing on a tile: object → desk → prop → wall · areas are deleted from the list on the right",
  "ยังไม่มีโซน": "No areas yet",
  "ยังไม่มีโต๊ะ": "No desks yet",
  "ยังไม่มีวัตถุ": "No objects yet",
  "เปลี่ยนชื่อ": "Rename",
  "ชื่อโซน": "Area name",
  "โซนใหม่": "New area",
  "ประชุม": "Meeting",
  "ใช้โซนนี้เป็นห้องประชุม": "Use this area as the meeting room",
  "ช่อง": "Tile",
  "บันทึกไม่ได้": "Cannot save",
  "กำลังบันทึก…": "Saving…",
  "ยังไม่ได้บันทึก": "Unsaved",
  "ลบไม่สำเร็จ": "Could not delete",
  "ลบแผนที่ที่ทำเอง แล้วกลับไปใช้แผนที่สำเร็จรูปของพื้นที่นี้?": "Delete this custom map and go back to the space's stock layout?",
  "ต้องเข้าสู่ระบบก่อน": "Sign in first",
  "เครื่องมือแก้ไขแผนที่ใช้ได้เฉพาะเจ้าของพื้นที่และผู้ดูแล เข้าสู่ระบบที่หน้าหลักก่อนแล้วกลับมาที่ลิงก์นี้อีกครั้ง": "The map editor is for owners and admins. Sign in on the main page, then come back to this link.",
  "ไม่พบพื้นที่นี้": "No such space",
  "ไม่มีพื้นที่ชื่อ \"{slug}\" — เปิดเครื่องมือนี้จากลิงก์ที่มี ?w=<slug> ของพื้นที่ที่ต้องการแก้": "There is no space called \"{slug}\" — open this tool from a link carrying the ?w=<slug> of the space you mean",
  "ติดต่อเซิร์ฟเวอร์ไม่ได้": "Cannot reach the server",
  "แผนผังออฟฟิศ": "Office layout",
  "ธีมสำเร็จรูปเลือกได้ตอนสร้าง Space เท่านั้น — ทุกคนต้องอยู่บนแผนผังเดียวกัน การเปลี่ยนภายหลังจะยกเลิกโต๊ะที่ทุกคนจองไว้": "A stock theme is chosen when the space is created — everyone has to be on the same layout, and changing it later would cancel every desk the team has claimed",
  "✎ แก้ไขแผนที่เอง": "✎ Edit the map yourself",
  // private-area names (see scenes/areas.ts) and the chip that names the one you are in
  "โซนพักผ่อน": "Lounge",
  "โซนทีม": "Team pod",
  "ห้องครัว": "Pantry",
  "ห้องเกม": "Game room",
  "ฝ่ายวิศวกรรม": "Engineering",
  "ฝ่ายออกแบบ": "Design",
  "ฝ่ายขาย": "Sales",
  "เฉพาะคนในโซนนี้": "this area only",
  "เข้า {area} — คุยกันเฉพาะคนในโซนนี้": "Entered {area} — only people in this area can hear you",
  "ยังไม่มีการแชร์หน้าจอ": "Nobody is sharing a screen",
  "กดปุ่ม": "Use",
  "แชร์จอ": "Share screen",
  "ที่แถบด้านล่างเพื่อเริ่มการนำเสนอ": "on the bar below to start presenting",
  "ผู้เล่น": "People",
  "ซ่อน": "Hide",
  "ไมค์": "Microphone",
  "เลือกอุปกรณ์ไมค์": "Choose a microphone",
  "กล้อง": "Camera",
  "เลือกกล้อง": "Choose a camera",
  "อีโมจิ": "Emoji",
  "ออกจากห้อง": "Leave the room",
  "กลับไปที่ตัวเรา": "Back to me",
  "ไปโต๊ะของฉัน": "Go to my desk",
  "ซูมเข้า": "Zoom in",
  "ซูมออก": "Zoom out",
  "ซูมออกสุด (M)": "Fit the whole map (M)",
  "ไม่อยู่": "Away",
  "ปิดไมค์": "Muted",
  "อยู่ในประชุม": "In a meeting",
  "ยังมีแค่คุณในห้องนี้ — ชวนเพื่อนร่วมงานเข้ามาได้เลย": "Just you in here so far — invite a colleague in",
  "{name} — {status}": "{name} — {status}",
  "{name} — {status} · ปิดไมค์": "{name} — {status} · muted",
  "— อนุญาตอุปกรณ์ก่อน (เปิดไมค์/กล้อง) —": "— allow device access first (turn on the mic or camera) —",
  "ไมโครโฟน": "Microphone",
  "ลำโพง": "Speaker",
  "สิทธิ์ผู้เยี่ยมชมจองโต๊ะไม่ได้ — ขอให้ผู้ดูแลตั้งคุณเป็นสมาชิก":
    "Visitors cannot claim a desk — ask an admin to make you a member",
  "workspace นี้เปิดให้เฉพาะสมาชิก — ขอให้เจ้าของเชิญคุณก่อน":
    "This workspace is members only — ask the owner to invite you",
  "ไม่พบ workspace นี้ — ตรวจสอบลิงก์เชิญอีกครั้ง": "No such workspace — check the invite link",
  "โต๊ะนี้มีเจ้าของแล้ว": "That desk is taken",
  "จองโต๊ะนี้เป็นโต๊ะของคุณแล้ว": "That desk is yours now",
  "ยกเลิกการจองโต๊ะแล้ว": "Desk released",
  "ยังไม่ได้เลือกโต๊ะ — คลิกที่โต๊ะเพื่อจอง": "No desk yet — click one to claim it",

  // ---- microphone and camera ----
  "ไม่พบไมโครโฟนบนเครื่องนี้": "No microphone found on this device",
  "ไม่พบกล้องบนเครื่องนี้": "No camera found on this device",
  "เบราว์เซอร์ไม่อนุญาตให้ใช้{device} — กดไอคอนหน้าช่อง URL แล้วอนุญาต":
    "Your browser is blocking the {device} — use the icon beside the address bar to allow it",
  "{device}ถูกโปรแกรมอื่นใช้อยู่ — ปิดโปรแกรมนั้นแล้วลองใหม่":
    "Another app is using the {device} — close it and try again",
  "ต้องเปิดผ่าน HTTPS จึงจะใช้ไมค์และกล้องได้": "The mic and camera need the site to be opened over HTTPS",
  "เปิด{device}ไม่สำเร็จ ({error})": "Could not turn the {device} on ({error})",
  "แชร์หน้าจอไม่สำเร็จ": "Could not share the screen",

  // ---- meeting view ----
  "มุมมองออฟฟิศ": "Office view",
  "มุมมองการประชุม": "Meeting view",
  "เปิดมุมมองการประชุม": "Open the meeting view",
  "ยังไม่มีใครอยู่ในห้องประชุม": "Nobody is in the meeting room",

  "แชทในการประชุม": "Meeting chat",
  "ส่งข้อความถึง {name}": "Message {name}",
  "ยังไม่มีข้อความในห้องนี้": "No messages in this room yet",
  "ยกมือ": "Raise hand",

  // ---- map themes ----
  "ออฟฟิศพาสเทล": "Pastel office",
  "ออฟฟิศแบ่งแผนก": "Office by department",
  "ออฟฟิศคลาสสิก (โต๊ะใหญ่)": "Classic office (large desks)",
  "เปิดไวท์บอร์ด Excalidraw": "Open the Excalidraw whiteboard",
  "แชร์จอขึ้นจอนำเสนอ": "Share your screen on the big screen",
  "เทเลพอร์ตไปโซนขวา": "Teleport to the right wing",
  "เทเลพอร์ตกลับ": "Teleport back",
};

/**
 * Translate a runtime string. `vars` fills {placeholders} after the lookup, so
 * one entry covers every value it is called with.
 */
export const t = (thai: string, vars?: Record<string, string | number>): string => {
  const s = lang() === "en" ? EN[thai] ?? thai : thai;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s;
};

// ---- static markup ----
// The Thai in index.html is the baseline, remembered on the first pass so
// switching back needs no second dictionary.
const original = new WeakMap<Node, string>();
const ATTRS = ["placeholder", "title", "alt", "aria-label"] as const;

/** the lookup key for a piece of DOM text: nbsp and runs of space collapsed */
const key = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

const swapText = (node: Text, to: Lang) => {
  const base = original.get(node) ?? node.data;
  if (!original.has(node)) original.set(node, node.data);
  if (to === "th") { node.data = base; return; }
  const en = EN[key(base)];
  if (!en) return;
  // Keep the node's own padding: the text is looked up normalised (nbsp and runs
  // of space collapsed), so the normalised form is not a substring of the raw one
  // and replacing it inside `base` would silently match nothing.
  node.data = (base.match(/^\s*/)?.[0] ?? "") + en + (base.match(/\s*$/)?.[0] ?? "");
};

const swapAttr = (el: Element, attr: string, to: Lang) => {
  const cur = el.getAttribute(attr);
  if (!cur) return;
  const mark = `${attr}:orig`;
  const base = el.getAttribute(`data-${mark}`) ?? cur;
  if (!el.hasAttribute(`data-${mark}`)) el.setAttribute(`data-${mark}`, cur);
  if (to === "th") { el.setAttribute(attr, base); return; }
  const en = EN[key(base)];
  if (en) el.setAttribute(attr, en);
};

/**
 * Walk the markup and put it in `to`. Only text that is in the dictionary moves,
 * so names and other data are left alone even when they are in this subtree.
 */
export const translateDom = (root: ParentNode = document.body, to: Lang = lang()) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (key((n as Text).data)) texts.push(n as Text);
  }
  for (const n of texts) swapText(n, to);
  for (const attr of ATTRS) {
    (root as Element).querySelectorAll?.(`[${attr}]`).forEach((el) => swapAttr(el, attr, to));
  }
};

const LANG_EVENT = "nexspace:lang";

export const setLang = (l: Lang) => {
  if (!LANGS.includes(l) || l === lang()) return;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode: this visit only */ }
  document.documentElement.lang = l;
  translateDom(document.body, l);
  // anything built at runtime re-renders itself off the new language
  document.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: { lang: l } }));
};

export const onLangChange = (fn: (l: Lang) => void) =>
  document.addEventListener(LANG_EVENT, (e) => fn((e as CustomEvent).detail.lang as Lang));

/** called once at start-up, for a page loading straight into English */
export const applyLang = () => {
  document.documentElement.lang = lang();
  if (lang() !== "th") translateDom(document.body, lang());
};
