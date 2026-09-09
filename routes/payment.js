const express=require('express');
const router=express.Router(); const db=require('../db'); const {requireAuth}=require('../middleware/auth'); const zarinpal=require('../utils/zarinpal');
function activeSale(courseId){return db.prepare(`SELECT * FROM flash_sales WHERE course_id=? AND is_active=1 AND datetime(starts_at)<=datetime('now') AND datetime(ends_at)>datetime('now') ORDER BY sale_price ASC LIMIT 1`).get(courseId);}
function price(c){const sale=activeSale(c.id);return sale?.sale_price ?? (c.discount_price||c.price);}
router.post('/checkout',requireAuth,async(req,res)=>{
 const ids=[...new Set((Array.isArray(req.session.cart)?req.session.cart:[]).map(Number).filter(Number.isInteger).filter(x=>x>0))], bids=[...new Set((Array.isArray(req.session.bundleCart)?req.session.bundleCart:[]).map(Number).filter(Number.isInteger).filter(x=>x>0))]; if(!ids.length&&!bids.length)return res.redirect('/cart');
 let items=ids.length?db.prepare(`SELECT * FROM courses WHERE is_published=1 AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids):[];
 // Re-check ownership at checkout time. A stale cart must never charge for a course
 // that the authenticated user already owns.
 if(items.length){
   const owned=new Set(db.prepare(`SELECT course_id FROM enrollments WHERE user_id=? AND course_id IN (${items.map(()=>'?').join(',')})`).all(req.session.user.id,...items.map(c=>c.id)).map(r=>Number(r.course_id)));
   items=items.filter(c=>!owned.has(Number(c.id)));
 }
 const bundles=bids.length?db.prepare(`SELECT * FROM bundles WHERE is_published=1 AND id IN (${bids.map(()=>'?').join(',')})`).all(...bids):[];
 if(bundles.length!==new Set(bids.map(Number)).size) return res.status(400).send('یکی از پکیج‌های سبد دیگر در دسترس نیست. سبد را تازه‌سازی کن.');
 const ownedCourseIds=new Set();
 {
   const candidateIds=[...new Set(bundles.flatMap(b=>db.prepare('SELECT course_id FROM bundle_items WHERE bundle_id=?').all(b.id).map(x=>Number(x.course_id))))];
   if(candidateIds.length){
     const rows=db.prepare(`SELECT course_id FROM enrollments WHERE user_id=? AND course_id IN (${candidateIds.map(()=>'?').join(',')})`).all(req.session.user.id,...candidateIds);
     rows.forEach(r=>ownedCourseIds.add(Number(r.course_id)));
   }
 }
 const bundleCourseIds=new Set();
 const pricedBundles=[];
 for(const b of bundles){
   const allBundleItems=db.prepare('SELECT c.id,c.is_published FROM bundle_items bi JOIN courses c ON c.id=bi.course_id WHERE bi.bundle_id=?').all(b.id);
   if(!allBundleItems.length || allBundleItems.some(c=>!c.is_published)) return res.status(400).send('یکی از پکیج‌های سبد ناقص یا موقتاً غیرفعال است. سبد را تازه‌سازی کن.');
   const remaining=allBundleItems.filter(c=>!ownedCourseIds.has(Number(c.id)));
   if(!remaining.length) continue;
   const adjustedPrice=Math.floor(Number(b.price||0)*remaining.length/allBundleItems.length);
   pricedBundles.push({...b,charge_price:Math.max(0,adjustedPrice)});
 }
 // Two selected bundles must not overlap: otherwise one course would be charged twice
 // while enrollment only happens once. Reject the checkout rather than overcharge.
 const seenBundleCourses=new Set();
 for(const b of pricedBundles){
   const bis=db.prepare('SELECT c.* FROM bundle_items bi JOIN courses c ON c.id=bi.course_id WHERE bi.bundle_id=? AND c.is_published=1').all(b.id);
   for(const c of bis){
     if(ownedCourseIds.has(Number(c.id))) continue;
     if(seenBundleCourses.has(Number(c.id))) return res.status(400).send('دو پکیج انتخاب‌شده یک یا چند دوره مشترک دارند. یکی از پکیج‌ها را از سبد حذف کن.');
     seenBundleCourses.add(Number(c.id));
     bundleCourseIds.add(Number(c.id));
   }
 }
 const selected=new Map();
 for(const b of pricedBundles){
   const bis=db.prepare('SELECT c.* FROM bundle_items bi JOIN courses c ON c.id=bi.course_id WHERE bi.bundle_id=? AND c.is_published=1').all(b.id);
   for(const c of bis){ if(!ownedCourseIds.has(Number(c.id))) selected.set(c.id,{course:c,price:0}); }
 }
 // A course already covered by a selected bundle must not also be charged as a standalone item.
 for(const c of items){ if(!bundleCourseIds.has(Number(c.id))) selected.set(c.id,{course:c,price:price(c)}); }
 const selectedCourses=[...selected.values()];
 // A stale cart can become empty after ownership is re-checked. Never create a
 // zero-item order or send an empty payment request in that case.
 if(selectedCourses.length===0 && pricedBundles.length===0){
   req.session.cart=[];
   return res.redirect('/cart?notice='+encodeURIComponent('همه دوره‌های سبد قبلاً خریداری شده‌اند.'));
 }
 const subtotal=selectedCourses.reduce((s,x)=>s+Number(x.price||0),0)+pricedBundles.reduce((s,b)=>s+Number(b.charge_price||0),0);
 let coupon=null,discount=0;if(req.session.coupon){coupon=db.prepare('SELECT * FROM coupons WHERE code=? AND is_active=1').get(req.session.coupon.code);if(coupon&&(!coupon.expires_at||new Date(coupon.expires_at)>=new Date())&&(!coupon.max_uses||db.prepare("SELECT COUNT(*) c FROM orders WHERE coupon_id=? AND status='paid'").get(coupon.id).c<coupon.max_uses)){discount=coupon.type==='percent'?Math.floor(subtotal*coupon.value/100):coupon.value;discount=Math.min(discount,subtotal);}else{req.session.coupon=null;coupon=null;}}
 let referral=null,refDiscount=0;if(req.session.referralCode){referral=db.prepare('SELECT * FROM referral_codes WHERE code=?').get(req.session.referralCode);if(referral&&referral.user_id!==req.session.user.id){const pctRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get();const capRow=db.prepare("SELECT value FROM settings WHERE key='referral_discount_cap'").get();const pct=Math.max(0,Math.min(100,Number(pctRow?.value ?? 5)||0));const cap=Math.max(0,Number(capRow?.value ?? 100000)||0);refDiscount=Math.min(cap,Math.floor(subtotal*pct/100));}}
 const amount=Math.max(0,subtotal-discount-refDiscount);
 const referralRecord=referral ? db.prepare("SELECT id,referrer_id FROM referrals WHERE referred_id=? AND referrer_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(req.session.user.id,referral.user_id) : null;
 let orderId;
 try {
   const createOrder=db.transaction(()=>{
     // Re-check the coupon inside the same SQLite write transaction that creates
     // the order. This closes the classic max_uses race where two checkouts both
     // observe the last available use before either order is inserted.
     if(coupon?.id && coupon.max_uses){
       const fresh=db.prepare('SELECT * FROM coupons WHERE id=? AND is_active=1').get(coupon.id);
       const pendingWindow="datetime('now','-30 minutes')";
       const usage=db.prepare(`SELECT
         COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) paid_count,
         COALESCE(SUM(CASE WHEN status='pending' AND created_at>=${pendingWindow} THEN 1 ELSE 0 END),0) pending_count
         FROM orders WHERE coupon_id=?`).get(coupon.id);
       const unavailable=!fresh || (fresh.expires_at && new Date(fresh.expires_at)<new Date()) ||
         Number(usage.paid_count||0)+Number(usage.pending_count||0)>=Number(fresh.max_uses);
       if(unavailable) throw new Error('COUPON_MAX_USES_REACHED');
       coupon=fresh;
     }
     const info=db.prepare('INSERT INTO orders(user_id,amount,status,coupon_id,discount_amount,referral_id) VALUES(?,?,?,?,?,?)').run(req.session.user.id,amount,'pending',coupon?.id||null,discount+refDiscount,referralRecord?.id||null);
     orderId=info.lastInsertRowid;
     const ins=db.prepare('INSERT INTO order_items(order_id,course_id,price) VALUES(?,?,?)');
     for(const x of selected.values()) ins.run(orderId,x.course.id,x.price);
     db.prepare('INSERT OR IGNORE INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)').run(req.session.user.id,'checkout_created','order',orderId,JSON.stringify({bundles:pricedBundles.map(b=>b.id),referral:referral?.code||null}));
   });
   createOrder();
 } catch(e) {
   if(e?.message==='COUPON_MAX_USES_REACHED'){
     req.session.coupon=null;
     return res.render('payment-result',{title:'کد تخفیف تمام شده',success:false,message:'ظرفیت استفاده از این کد تخفیف در همین لحظه تکمیل شده است.'});
   }
   throw e;
 }
 if(amount===0){
   const tx=db.transaction(()=>{
     db.prepare("UPDATE orders SET status='paid',ref_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run('FREE-'+orderId,orderId);
     const items=db.prepare('SELECT course_id FROM order_items WHERE order_id=?').all(orderId);
     const en=db.prepare('INSERT OR IGNORE INTO enrollments(user_id,course_id,order_id) VALUES(?,?,?)');
     for(const i of items) en.run(req.session.user.id,i.course_id,orderId);
     if(referralRecord){
       const rewardPercentRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get();
       const rewardCapRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_cap'").get();
       const rewardPercent=Math.max(0,Math.min(100,Number(rewardPercentRow?.value ?? 5)||0));
       const rewardCap=Math.max(0,Number(rewardCapRow?.value ?? 100000)||0);
       const rewardAmount=Math.min(rewardCap,Math.floor(amount*rewardPercent/100));
       const marked=db.prepare("UPDATE referrals SET status='rewarded',reward_amount=? WHERE id=? AND status='pending'").run(rewardAmount,referralRecord.id);
       if(marked.changes===1) db.prepare("INSERT OR IGNORE INTO referral_rewards(referral_id,referrer_id,order_id,amount) VALUES(?,?,?,?)").run(referralRecord.id,referralRecord.referrer_id,orderId,rewardAmount);
     }
   });
   tx(); req.session.cart=[];req.session.bundleCart=[];req.session.coupon=null;req.session.referralCode=null;
   return res.render('payment-result',{title:'سفارش رایگان',success:true,message:'تخفیف‌ها کل مبلغ سفارش را پوشش دادند. دوره‌ها با موفقیت به حساب شما اضافه شدند.'});
 }
 const callbackUrl=`${req.protocol}://${req.get('host')}/payment/verify?order=${orderId}`; const result=await zarinpal.requestPayment({amount,description:`خرید ${selectedCourses.length} دوره از گلو آپ آکادمی - سفارش #${orderId}`,callbackUrl,mobile:req.session.user.phone});
 if(!result.ok){db.prepare("UPDATE orders SET status=? WHERE id=? AND status='pending'").run('failed',orderId);return res.render('payment-result',{title:'خطا در پرداخت',success:false,message:'اتصال به درگاه پرداخت با خطا مواجه شد.'});}
 db.prepare("UPDATE orders SET authority=? WHERE id=? AND status='pending'").run(result.authority,orderId);res.redirect(result.payUrl);
});
router.get('/verify',async(req,res)=>{const {Authority,Status,order}=req.query;const o=db.prepare('SELECT * FROM orders WHERE id=?').get(order);if(!o)return res.status(404).render('404',{title:'سفارش پیدا نشد'});if(o.status==='paid')return res.render('payment-result',{title:'پرداخت موفق',success:true,message:`این سفارش قبلاً تایید شده است. کد پیگیری: ${o.ref_id||'ثبت‌شده'}`});if(o.status!=='pending')return res.render('payment-result',{title:'سفارش نهایی شده',success:o.status==='paid',message:'این سفارش قبلاً نهایی شده و امکان تغییر وضعیت آن وجود ندارد.'});if(Status!=='OK'){if(!Authority||Authority!==o.authority)return res.render('payment-result',{title:'پرداخت نامعتبر',success:false,message:'اطلاعات بازگشت درگاه معتبر نیست.'});db.prepare("UPDATE orders SET status=? WHERE id=? AND status='pending' AND authority=?").run('canceled',o.id,Authority);return res.render('payment-result',{title:'پرداخت لغو شد',success:false,message:'پرداخت توسط شما لغو شد.'});}if(!Authority||Authority!==o.authority){db.prepare("UPDATE orders SET status=? WHERE id=? AND status='pending'").run('failed',o.id);return res.render('payment-result',{title:'پرداخت نامعتبر',success:false,message:'اطلاعات بازگشت درگاه معتبر نیست.'});}const result=await zarinpal.verifyPayment({amount:o.amount,authority:Authority});if(!result.ok){db.prepare("UPDATE orders SET status=? WHERE id=? AND status='pending'").run('failed',o.id);return res.render('payment-result',{title:'پرداخت ناموفق',success:false,message:'تراکنش تایید نشد.'});}
 const tx=db.transaction(()=>{
   const updated=db.prepare("UPDATE orders SET status='paid',ref_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND authority=?").run(result.refId,o.id,Authority);
   if (updated.changes !== 1) return false;
   const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
   const en=db.prepare('INSERT OR IGNORE INTO enrollments(user_id,course_id,order_id) VALUES(?,?,?)');
   for(const i of items) en.run(o.user_id,i.course_id,o.id);
   const referral=db.prepare("SELECT id,referrer_id FROM referrals WHERE id=? AND referred_id=? AND status='pending' LIMIT 1").get(o.referral_id,o.user_id);
   if (referral) {
     const rewardPercentRow = db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get();
     const rewardCapRow = db.prepare("SELECT value FROM settings WHERE key='referral_reward_cap'").get();
     const rewardPercent = Math.max(0, Math.min(100, Number(rewardPercentRow?.value ?? 5) || 0));
     const rewardCap = Math.max(0, Number(rewardCapRow?.value ?? 100000) || 0);
     const rewardAmount = Math.min(rewardCap, Math.floor(o.amount * rewardPercent / 100));
     const marked = db.prepare("UPDATE referrals SET status='rewarded', reward_amount=? WHERE id=? AND status='pending'").run(rewardAmount, referral.id);
     if (marked.changes === 1) {
       db.prepare("INSERT OR IGNORE INTO referral_rewards(referral_id,referrer_id,order_id,amount) VALUES(?,?,?,?)").run(referral.id, referral.referrer_id, o.id, rewardAmount);
       db.prepare("INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)").run(referral.referrer_id,'معرفی موفق 🎉',`خرید دوستت تکمیل شد و ${rewardAmount.toLocaleString('fa-IR')} تومان پاداش معرفی برایت ثبت شد.`,'referral','/referral');
     }
   }
   return true;
 });
 const paidNow=tx();
 if (!paidNow) return res.render('payment-result',{title:'پرداخت موفق',success:true,message:`این سفارش قبلاً تایید شده است. کد پیگیری: ${o.ref_id||result.refId}`});
 req.session.cart=[];req.session.bundleCart=[];req.session.coupon=null;req.session.referralCode=null;res.render('payment-result',{title:'پرداخت موفق',success:true,message:`پرداخت با موفقیت انجام شد. کد پیگیری: ${result.refId}`});});
module.exports=router;