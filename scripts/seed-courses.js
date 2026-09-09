const db = require('../db');

function upsertCategory(title, slug) {
  const existing = db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO categories(title,slug) VALUES(?,?)').run(title,slug).lastInsertRowid;
}

function upsertCourse(c) {
  const existing = db.prepare('SELECT id FROM courses WHERE slug=?').get(c.slug);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO courses
    (title,slug,subtitle,description,cover_image,price,discount_price,sessions_count,category_id,is_published,is_featured)
    VALUES (@title,@slug,@subtitle,@description,@cover_image,@price,@discount_price,@sessions_count,@category_id,1,@is_featured)`).run(c).lastInsertRowid;
}

function ensureSessions(courseId,count) {
  const current=Number(db.prepare('SELECT COUNT(*) c FROM course_sessions WHERE course_id=?').get(courseId).c||0);
  if(current>=count) return;
  const insert=db.prepare(`INSERT INTO course_sessions
    (course_id,title,phase,video_url,duration_seconds,sort_order,is_free_preview)
    VALUES(?,?,?,?,?,?,?)`);
  const tx=db.transaction(()=>{
    for(let i=current+1;i<=count;i++) insert.run(courseId,`جلسه ${i}`,`فاز ${Math.ceil(i/5)}`,null,0,i,i===1?1:0);
  });
  tx();
}

const fitness=upsertCategory('تناسب اندام','fitness');
const style=upsertCategory('استایل و ظاهر','style');
const mind=upsertCategory('ذهن و روان','mind');

const courses=[
  {title:'بدنتو بساز',slug:'body-transformation',subtitle:'برنامه تمرینی و رژیم حرفه‌ای',description:'یک برنامه کامل تمرینی و تغذیه برای ساخت بدنی متناسب و قدرتمند.',cover_image:'/uploads/course-body.jpg',price:890000,discount_price:690000,sessions_count:30,category_id:fitness,is_featured:1},
  {title:'خط و فک و صورت مردانه',slug:'face-jawline',subtitle:'چهره‌ای جذاب و متناسب',description:'تمرینات و تکنیک‌های تخصصی برای بهبود ظاهر خط فک و صورت.',cover_image:'/uploads/course-face.jpg',price:450000,discount_price:null,sessions_count:15,category_id:style,is_featured:1},
  {title:'دوره کامل گلو آپ در ۳۰ روز',slug:'full-glowup-30days',subtitle:'برنامه جامع تغییر در ۴ فاز',description:'مسیر کامل تحول ظاهری و ذهنی در یک برنامه ۳۰ روزه و چهار فازی.',cover_image:'/uploads/course-full.jpg',price:1490000,discount_price:1190000,sessions_count:30,category_id:style,is_featured:1},
  {title:'استایل و جذابیت',slug:'style-charisma',subtitle:'تیپ، اعتماد به نفس، زبان بدن',description:'اصول استایل شخصی، پوشش مناسب و افزایش جذابیت ظاهری.',cover_image:'/uploads/course-style.jpg',price:590000,discount_price:null,sessions_count:12,category_id:style,is_featured:1},
  {title:'ذهن قدرتمند',slug:'strong-mind',subtitle:'تمرکز، عادت‌سازی، دیسیپلین',description:'ساخت ذهنی قوی از طریق تمرکز، نظم و عادت‌های سازنده.',cover_image:'/uploads/course-mind.jpg',price:650000,discount_price:520000,sessions_count:18,category_id:mind,is_featured:1}
];

for(const course of courses){
  const id=upsertCourse(course);
  ensureSessions(id,course.sessions_count);
}

console.log('✅ دوره‌های نمونه برای محیط آنلاین آماده شدند.');
