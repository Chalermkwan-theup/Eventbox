# 🔥 AI Dev Team for Claude Code

ทีม Dev 7 ตัว (Tech Lead + 6 subagents) พร้อมวางใน repo — แต่ละ Agent มี context window แยก, จำกัดสิทธิ์ tools ตามหน้าที่ และมี model ที่เหมาะกับงาน

## โครงสร้าง

```
your-repo/
├── CLAUDE.md                        ← ธรรมนูญทีม: workflow + กติกาเหล็ก
└── .claude/
    └── agents/
        ├── architect.md             ← ออกแบบก่อนเขียน (opus, read-only)
        ├── backend-dev.md           ← เขียน API/logic/DB (sonnet, แก้โค้ดได้)
        ├── frontend-dev.md          ← เขียน UI (sonnet, แก้โค้ดได้)
        ├── security-auditor.md      ← หาช่องโหว่ (opus, read-only ห้ามแก้โค้ด)
        ├── qa-tester.md             ← เขียน+รัน test (sonnet)
        ├── code-reviewer.md         ← review แบบ PR (opus, read-only)
        └── devops.md                ← deploy plan (sonnet)
```

## วิธีติดตั้ง

1. Copy โฟลเดอร์ `.claude/` และ `CLAUDE.md` ไปวางที่ root ของ repo
2. แก้ส่วน **Project Context** ท้ายไฟล์ `CLAUDE.md` ให้ตรง stack ของคุณ
3. เปิด `claude` ใน repo — ทีมพร้อมทำงานทันที
4. เช็คว่า Claude Code เห็นทีมครบ: พิมพ์ `/agents`

> อยากให้ทีมนี้ใช้ได้ทุกโปรเจกต์ ให้ย้ายไฟล์ agents ไปไว้ที่ `~/.claude/agents/` แทน
> (ถ้าชื่อชนกัน ตัวใน project จะชนะตัวใน user scope)

## วิธีใช้

**ปล่อยให้ Tech Lead จัดการเอง** — สั่งงานปกติ Claude จะ delegate ตาม workflow ใน CLAUDE.md

```
> สร้าง API สำหรับระบบ promo code พร้อมหน้า admin จัดการ
```

**หรือเรียก Agent ตรงๆ**

```
> ให้ architect ออกแบบระบบ notification ก่อน ยังไม่ต้องเขียน
> ให้ security-auditor ตรวจ diff ล่าสุด
> ให้ code-reviewer ดู PR นี้หน่อย
> ให้ qa-tester รัน test ทั้งหมดแล้วสรุปเฉพาะตัวที่ fail
```

## จุดที่ "เข้มข้น" ของทีมนี้

- **สิทธิ์แยกตามหน้าที่** — reviewer/security/architect ไม่มี Write/Edit → ตรวจอย่างเดียว แก้เองไม่ได้ เหมือน reviewer จริงที่ approve/reject ผ่าน comment
- **Model ตามความยากของงาน** — งานคิดหนัก (design, security, review) ใช้ opus / งานลงมือใช้ sonnet คุมทั้งคุณภาพและ cost
- **Context แยก** — รัน test ทั้ง suite, scan repo, อ่าน log ยาวๆ อยู่ใน context ของ subagent สรุปเฉพาะที่สำคัญกลับมา → session หลักไม่บวม ทำงานยาวได้ไม่เบลอ
- **ตีกลับได้จริง** — reviewer จบด้วย verdict Approve/Request changes ถ้าไม่ผ่าน workflow บังคับวนกลับไปแก้

## ปรับแต่งต่อ

- เพิ่ม Agent ใหม่: สร้างไฟล์ `.md` ใน `.claude/agents/` ตาม format เดิม หรือใช้คำสั่ง `/agents` ให้ Claude ช่วยสร้าง
- เอกสารทางการ: https://code.claude.com/docs/en/sub-agents

---
*THE AI EMPIRE × AIYA — AI Dev Team v1.0*
