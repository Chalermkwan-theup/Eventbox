import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container container--narrow empty-state">
      <h1>ไม่พบหน้าที่คุณต้องการ</h1>
      <p>ลิงก์นี้อาจไม่ถูกต้อง หรือรายการที่คุณค้นหาอาจถูกลบไปแล้ว</p>
      <Link href="/events" className="btn btn-primary">
        กลับไปหน้ากิจกรรม
      </Link>
    </div>
  );
}
