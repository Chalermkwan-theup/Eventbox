/**
 * Translates the `error` codes our API routes return (see the KNOWN_RPC_ERRORS
 * table in lib/errors.ts, plus the ad-hoc codes each route.ts adds on top) into
 * the Thai-language messages the UI actually shows. The API layer intentionally
 * keeps its `message` field in English for logs/ops; this is the client-facing
 * i18n boundary — do not display `body.message` directly anywhere in app/ or
 * components/.
 */
const TH_MESSAGES: Record<string, string> = {
  // Generic / shared
  UNAUTHENTICATED: "กรุณาเข้าสู่ระบบก่อนทำรายการ",
  VALIDATION_ERROR: "ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  INVALID_JSON: "คำขอไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง",
  RATE_LIMITED: "คุณทำรายการถี่เกินไป กรุณาลองใหม่อีกครั้งในอีกสักครู่",
  INTERNAL_ERROR: "เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่อีกครั้ง",

  // Reserve (POST /api/checkout/reserve)
  EMPTY_ITEMS: "กรุณาเลือกจำนวนตั๋วอย่างน้อย 1 ใบ",
  DUPLICATE_TIER_IN_REQUEST: "มีประเภทตั๋วซ้ำในคำขอ กรุณาลองใหม่",
  INVALID_QUANTITY: "จำนวนตั๋วไม่ถูกต้อง",
  EVENT_NOT_ON_SALE: "กิจกรรมนี้ไม่ได้เปิดขายตั๋วในขณะนี้",
  INVALID_TIER_FOR_EVENT: "ประเภทตั๋วไม่ตรงกับกิจกรรมนี้",
  PROMO_NOT_APPLICABLE: "ไม่สามารถใช้โค้ดส่วนลดนี้กับคำสั่งซื้อนี้ได้",
  PROMO_PER_USER_LIMIT_EXCEEDED: "คุณใช้โค้ดส่วนลดนี้ครบจำนวนสิทธิ์แล้ว",
  PER_USER_LIMIT_EXCEEDED: "คุณซื้อตั๋วประเภทนี้ครบจำนวนสิทธิ์สูงสุดต่อคนแล้ว",
  SOLD_OUT: "ตั๋วประเภทที่เลือกหมดแล้ว",
  ZERO_TOTAL_NOT_SUPPORTED: "คำสั่งซื้อนี้มียอดชำระเป็นศูนย์ ระบบยังไม่รองรับกรณีนี้",

  // Pay (POST /api/checkout/:orderId/pay)
  INVALID_ORDER_ID: "รหัสคำสั่งซื้อไม่ถูกต้อง",
  ORDER_NOT_FOUND: "ไม่พบคำสั่งซื้อนี้",
  ORDER_NOT_PENDING: "คำสั่งซื้อนี้ไม่ได้อยู่ในสถานะรอชำระเงินแล้ว",
  INVALID_ORDER_TOTAL: "ยอดคำสั่งซื้อไม่ถูกต้อง",
  PAYMENT_PROVIDER_ERROR: "ไม่สามารถเริ่มการชำระเงินได้ กรุณาลองใหม่อีกครั้ง",
  ALREADY_PAID_DIFFERENT_INTENT: "คำสั่งซื้อนี้ถูกชำระเงินไปแล้วด้วยรายการอื่น",

  // Waitlist (POST /api/waitlist/join)
  TIER_NOT_FOUND: "ไม่พบประเภทตั๋วนี้สำหรับกิจกรรมนี้",
  TIER_AVAILABLE: "ตั๋วประเภทนี้ยังมีจำหน่ายอยู่ ไม่จำเป็นต้องลงชื่อรอคิว",
  ALREADY_ON_WAITLIST: "คุณอยู่ในรายชื่อรอคิวของตั๋วประเภทนี้อยู่แล้ว",

  // Tickets / QR (GET /api/tickets/:ticketId/qr)
  INVALID_TICKET_ID: "รหัสตั๋วไม่ถูกต้อง",
  TICKET_NOT_FOUND: "ไม่พบตั๋วนี้",
  TICKET_NOT_ACTIVE: "ตั๋วนี้ไม่สามารถใช้งานได้แล้ว",

  // Events (GET /api/events/:eventId/availability, GET /api/events/:eventId/stats)
  INVALID_EVENT_ID: "รหัสกิจกรรมไม่ถูกต้อง",
  EVENT_NOT_FOUND: "ไม่พบกิจกรรมนี้",

  // Check-in (POST /api/checkin) — gate scanner + organizer dashboard (Phase 4)
  INVALID_TOKEN: "QR โค้ดนี้ไม่ถูกต้องหรืออ่านไม่ได้ กรุณาลองสแกนใหม่ หรือกรอกรหัสด้วยตนเอง",
  NOT_EVENT_STAFF: "คุณไม่มีสิทธิ์เช็คอินหรือดูข้อมูลของกิจกรรมนี้",
  TICKET_VOID: "ตั๋วใบนี้ถูกยกเลิกแล้ว ไม่สามารถเช็คอินได้",
  TICKET_ALREADY_CHECKED_IN: "ตั๋วใบนี้เช็คอินไปแล้ว",
};

const DEFAULT_MESSAGE = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";

export function translateApiError(code: string | undefined | null): string {
  if (!code) return DEFAULT_MESSAGE;
  return TH_MESSAGES[code] ?? DEFAULT_MESSAGE;
}
