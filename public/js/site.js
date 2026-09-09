// افکت نور دنبال‌کننده‌ی موس (روی دسکتاپ)
document.documentElement.classList.add('page-ready');

// ---------- سیستم نوتیفیکیشن Toast ----------
function showToast(message, type = 'default') {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type !== 'default' ? ' ' + type : '');
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}
window.showToast = showToast;

document.addEventListener('DOMContentLoaded', () => {
  // CSRF token را به همه فرم‌های POST اضافه می‌کنیم؛ APIها هم از هدر استفاده می‌کنند.
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  if (csrfMeta) {
    const token = csrfMeta.content;
    document.querySelectorAll('form[method="POST"], form[method="post"]').forEach(form => {
      if (!form.querySelector('input[name="_csrf"]')) {
        const input=document.createElement('input'); input.type='hidden'; input.name='_csrf'; input.value=token; form.appendChild(input);
      }
    });
    window.GlowUp = window.GlowUp || {};
    window.GlowUp.csrf = token;
  }
  // ---------- نوار پیشرفت اسکرول بالای صفحه ----------
  let progressBar = document.getElementById('scroll-progress');
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.id = 'scroll-progress';
    progressBar.innerHTML = '<div id="scroll-progress-fill"></div>';
    document.body.prepend(progressBar);
  }
  const progressFillEl = document.getElementById('scroll-progress-fill');
  function updateScrollProgress() {
    const h = document.documentElement;
    const scrolled = h.scrollTop;
    const max = h.scrollHeight - h.clientHeight;
    progressFillEl.style.width = (max > 0 ? (scrolled / max) * 100 : 0) + '%';
  }
  window.addEventListener('scroll', updateScrollProgress, { passive: true });
  updateScrollProgress();

  // ---------- نمایش/مخفی‌کردن رمز عبور ----------
  document.querySelectorAll('.toggle-pass').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.closest('.input-icon-group').querySelector('input');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      btn.textContent = isPass ? 'مخفی' : 'نمایش';
    });
  });

  // ---------- سنجش قدرت رمز عبور (صفحه‌ی ثبت‌نام) ----------
  const pwInput = document.getElementById('regPassword');
  const pwFill = document.getElementById('pwStrengthFill');
  const pwLabel = document.getElementById('pwStrengthLabel');
  if (pwInput && pwFill) {
    pwInput.addEventListener('input', () => {
      const v = pwInput.value;
      let score = 0;
      if (v.length >= 6) score++;
      if (v.length >= 10) score++;
      if (/[A-Z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      const levels = [
        { pct: 0, color: '#3a2020', label: '' },
        { pct: 20, color: '#f08a8a', label: 'ضعیف' },
        { pct: 40, color: '#f0cf6a', label: 'متوسط' },
        { pct: 65, color: '#f0cf6a', label: 'خوب' },
        { pct: 85, color: 'var(--accent2)', label: 'قوی' },
        { pct: 100, color: 'var(--accent2)', label: 'خیلی قوی' }
      ];
      const lvl = levels[Math.min(score, 5)];
      pwFill.style.width = (v.length ? lvl.pct : 0) + '%';
      pwFill.style.background = lvl.color;
      pwLabel.textContent = v.length ? lvl.label : '';
    });
  }

  // ---------- جستجوی سریع داخل جدول‌های پنل ادمین ----------
  document.querySelectorAll('.js-table-search').forEach(input => {
    const scope = input.closest('.admin-content') || document;
    const table = scope.querySelector('table.data-table');
    if (!table) return;
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      table.querySelectorAll('tbody tr').forEach(row => {
        const match = !q || row.textContent.toLowerCase().includes(q);
        row.classList.toggle('ts-hidden', !match);
      });
    });
  });

  // ---------- Wishlist عمومی کارت‌های دوره ----------
  document.querySelectorAll('.card-wishlist').forEach(btn => {
    if (btn.dataset.wishlistBound === '1') return;
    btn.dataset.wishlistBound = '1';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      try {
        const token = window.GlowUp?.csrf || document.querySelector('meta[name=csrf-token]')?.content || '';
        const r = await fetch('/wishlist/' + encodeURIComponent(btn.dataset.courseId) + '/toggle', {
          method: 'POST',
          headers: { 'x-csrf-token': token, 'Accept': 'application/json' }
        });
        if (!r.ok) throw new Error('wishlist request failed');
        const d = await r.json();
        btn.classList.toggle('active', !!d.wished);
        btn.textContent = d.wished ? '♥' : '♡';
        btn.setAttribute('aria-pressed', d.wished ? 'true' : 'false');
        btn.title = d.wished ? 'حذف از ذخیره‌ها' : 'ذخیره دوره';
        if (window.showToast) showToast(d.wished ? 'دوره به ذخیره‌ها اضافه شد' : 'دوره از ذخیره‌ها حذف شد', 'success');
      } catch (err) {
        if (window.showToast) showToast('ذخیره دوره انجام نشد؛ دوباره امتحان کن', 'error');
      } finally {
        delete btn.dataset.busy;
      }
    });
  });

  // ---------- اعلان‌های پنل ادمین ----------
  const bellBtn = document.getElementById('notifBellBtn');
  const bellPanel = document.getElementById('notifBellPanel');
  if (bellBtn && bellPanel) {
    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bellPanel.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!bellPanel.contains(e.target) && e.target !== bellBtn) bellPanel.classList.remove('open');
    });
  }

  // ---------- نمودار روند درآمد (کانواس ساده، بدون کتابخانه) ----------
  const revCanvas = document.getElementById('revenueChart');
  if (revCanvas && window.__revenueChartData) {
    const ctx = revCanvas.getContext('2d');
    const data = window.__revenueChartData;
    const wrap = revCanvas.closest('.revenue-chart-wrap');
    let tooltip = wrap.querySelector('.chart-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip';
      wrap.appendChild(tooltip);
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = revCanvas.clientWidth, h = revCanvas.clientHeight;
      revCanvas.width = w * dpr; revCanvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const values = data.map(d => d.total);
      const max = Math.max(...values, 1);
      const pad = 10;
      const stepX = (w - pad * 2) / (values.length - 1 || 1);
      const points = values.map((v, i) => ({
        x: w - pad - i * stepX, // راست‌چین برای طبیعی‌بودن جهت RTL
        y: h - pad - (v / max) * (h - pad * 2)
      }));

      // ناحیه‌ی زیر منحنی
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(201,163,90,.35)');
      grad.addColorStop(1, 'rgba(201,163,90,0)');
      ctx.beginPath();
      ctx.moveTo(points[0].x, h - pad);
      points.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.lineTo(points[points.length - 1].x, h - pad);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // خط منحنی
      ctx.beginPath();
      points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = '#e9c77a';
      ctx.lineWidth = 2;
      ctx.stroke();

      // نقاط
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#0f0f11';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#e9c77a';
        ctx.stroke();
      });

      revCanvas.onmousemove = (e) => {
        const rect = revCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let nearest = 0, best = Infinity;
        points.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < best) { best = d; nearest = i; } });
        const p = points[nearest];
        tooltip.style.left = p.x + 'px';
        tooltip.style.top = p.y + 'px';
        tooltip.textContent = data[nearest].total.toLocaleString('fa-IR') + ' تومان';
        tooltip.classList.add('show');
      };
      revCanvas.onmouseleave = () => tooltip.classList.remove('show');
    }
    draw();
    window.addEventListener('resize', draw);
  }

  // ---------- Command Palette جستجوی سراسری ادمین (Ctrl+K) ----------
  const cmdkBtn = document.getElementById('cmdkBtn');
  const cmdkOverlay = document.getElementById('cmdkOverlay');
  const cmdkInput = document.getElementById('cmdkInput');
  const cmdkResults = document.getElementById('cmdkResults');
  if (cmdkOverlay && cmdkInput) {
    function openCmdk() {
      cmdkOverlay.classList.add('open');
      cmdkInput.value = '';
      cmdkResults.innerHTML = '<div class="cmdk-empty">برای جستجو تایپ کن…</div>';
      setTimeout(() => cmdkInput.focus(), 30);
    }
    function closeCmdk() { cmdkOverlay.classList.remove('open'); }
    if (cmdkBtn) cmdkBtn.addEventListener('click', openCmdk);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
      if (e.key === 'Escape') closeCmdk();
    });
    cmdkOverlay.addEventListener('click', (e) => { if (e.target === cmdkOverlay) closeCmdk(); });

    let cmdkTimer;
    cmdkInput.addEventListener('input', () => {
      clearTimeout(cmdkTimer);
      const q = cmdkInput.value.trim();
      if (!q) { cmdkResults.innerHTML = '<div class="cmdk-empty">برای جستجو تایپ کن…</div>'; return; }
      cmdkTimer = setTimeout(async () => {
        try {
          const res = await fetch('/admin/search?q=' + encodeURIComponent(q));
          const data = await res.json();
          renderCmdkResults(data);
        } catch (e) {
          cmdkResults.innerHTML = '<div class="cmdk-empty">خطا در جستجو</div>';
        }
      }, 220);
    });

    function renderCmdkResults(data) {
      function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
      const groups = [];
      if (data.courses && data.courses.length) {
        groups.push({ label: 'دوره‌ها', items: data.courses.map(c => ({ ico: '🎓', title: c.title, sub: '', href: '/admin/courses/' + c.id + '/edit' })) });
      }
      if (data.users && data.users.length) {
        groups.push({ label: 'کاربران', items: data.users.map(u => ({ ico: '👤', title: u.full_name, sub: u.phone, href: '/admin/users' })) });
      }
      if (data.orders && data.orders.length) {
        groups.push({ label: 'سفارش‌ها', items: data.orders.map(o => ({ ico: '💳', title: '#' + o.id + ' — ' + o.full_name, sub: o.amount.toLocaleString('fa-IR') + ' تومان', href: '/admin/orders/' + o.id })) });
      }
      if (!groups.length) { cmdkResults.innerHTML = '<div class="cmdk-empty">نتیجه‌ای پیدا نشد</div>'; return; }
      cmdkResults.innerHTML = groups.map(g => `
        <div class="cmdk-group-label">${esc(g.label)}</div>
        ${g.items.map(it => `
          <a class="cmdk-result" href="${it.href}">
            <span class="cr-ico">${it.ico}</span>
            <span><div>${esc(it.title)}</div>${it.sub ? `<div class="cr-sub">${esc(it.sub)}</div>` : ''}</span>
          </a>
        `).join('')}
      `).join('');
    }
  }

  // منوی موبایل (همبرگری)
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  const menuBackdrop = document.getElementById('menuBackdrop');
  function closeMenu() { mobileMenu?.classList.remove('open'); menuBackdrop?.classList.remove('open'); }
  if (hamburgerBtn && mobileMenu) {
    hamburgerBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
      menuBackdrop.classList.toggle('open');
    });
    menuBackdrop?.addEventListener('click', closeMenu);
    mobileMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  }

  const glow = document.createElement('div');
  glow.id = 'cursor-glow';
  document.body.appendChild(glow);
  window.addEventListener('mousemove', (e) => {
    glow.style.opacity = '1';
    glow.style.left = e.clientX + 'px';
    glow.style.top = e.clientY + 'px';
  });
  window.addEventListener('mouseleave', () => { glow.style.opacity = '0'; });

  // شمارنده‌ی انیمیشنی برای آمار صفحه‌ی اصلی
  const counters = document.querySelectorAll('.counter');
  if (counters.length) {
    const animate = (el) => {
      const target = parseInt(el.dataset.target, 10) || 0;
      const duration = 1200;
      const start = performance.now();
      function tick(now) {
        const progress = Math.min((now - start) / duration, 1);
        const value = Math.floor(progress * target);
        el.textContent = '+' + value.toLocaleString('fa-IR');
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = '+' + target.toLocaleString('fa-IR');
      }
      requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          animate(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    counters.forEach(c => observer.observe(c));
  }

  // ---------- کاروسل سه‌بعدی (Coverflow) برای دوره‌های پرطرفدار ----------
  document.querySelectorAll('.coverflow').forEach(cf => {
    const stage = cf.querySelector('.coverflow-stage');
    const items = Array.from(stage.children);
    const dots = cf.querySelectorAll('.cf-dot');
    const prevBtn = cf.querySelector('.cf-prev');
    const nextBtn = cf.querySelector('.cf-next');
    if (!items.length) return;
    let active = 0;
    let autoplay;

    function render() {
      const n = items.length;
      items.forEach((item, i) => {
        let offset = i - active;
        if (offset > n / 2) offset -= n;
        if (offset < -n / 2) offset += n;
        const abs = Math.abs(offset);
        const x = offset * 205;
        const rotate = offset * -30;
        const z = -abs * 155;
        const scale = Math.max(0.48, 1 - abs * 0.17);
        const opacity = abs > 2 ? 0 : 1 - abs * 0.24;
        item.style.transform = `translateX(${x}px) translateZ(${z}px) rotateY(${rotate}deg) scale(${scale})`;
        item.style.opacity = opacity;
        item.style.filter = abs === 0 ? 'blur(0px)' : `blur(${Math.min(abs * 1.2, 3)}px)`;
        item.style.zIndex = 100 - abs;
        item.style.pointerEvents = abs > 2 ? 'none' : 'auto';
      });
      dots.forEach((d, i) => d.classList.toggle('active', i === active));
    }
    function go(i) { active = (i + items.length) % items.length; render(); }
    function restartAutoplay() {
      clearInterval(autoplay);
      autoplay = setInterval(() => go(active + 1), 4500);
    }

    items.forEach((item, i) => {
      item.addEventListener('click', (e) => {
        if (i !== active) { e.preventDefault(); e.stopPropagation(); go(i); restartAutoplay(); }
      });
    });
    dots.forEach((d, i) => d.addEventListener('click', () => { go(i); restartAutoplay(); }));
    if (prevBtn) prevBtn.addEventListener('click', () => { go(active - 1); restartAutoplay(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { go(active + 1); restartAutoplay(); });

    // پشتیبانی از کشیدن انگشت (Swipe) روی موبایل
    let touchStartX = 0;
    stage.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 40) {
        // در RTL: کشیدن به راست یعنی برو قبلی، کشیدن به چپ یعنی برو بعدی
        if (dx > 0) go(active - 1); else go(active + 1);
        restartAutoplay();
      }
    }, { passive: true });

    render();
    restartAutoplay();
  });

  // ---------- انیمیشن ظاهرشدن هنگام اسکرول (Scroll Reveal) ----------
  const revealTargets = document.querySelectorAll('.reveal, .reveal-stagger');
  if (revealTargets.length) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    revealTargets.forEach(el => revealObserver.observe(el));
  }

  // ---------- افکت تیلت سه‌بعدی روی کارت‌ها (به‌جز کارت‌های داخل کاورفلو که خودشان چرخش سه‌بعدی دارند) ----------
  document.querySelectorAll('.tilt').forEach(card => {
    if (card.closest('.coverflow-item')) return;
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      if (card.classList.contains('premium-course-card')) {
        card.style.setProperty('--mx', ((x + .5) * 100) + '%');
        card.style.setProperty('--my', ((y + .5) * 100) + '%');
        card.style.setProperty('--rx', (-y * 8) + 'deg');
        card.style.setProperty('--ry', (x * 8) + 'deg');
        card.style.transform = `perspective(1100px) rotateX(${-y * 8}deg) rotateY(${x * 8}deg) translateY(-9px) translateZ(8px)`;
      } else {
        card.style.transform = `perspective(700px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-5px)`;
      }
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      if (card.classList.contains('premium-course-card')) {
        card.style.setProperty('--mx','50%'); card.style.setProperty('--my','50%');
      }
    });
  });

  // ---------- ذرات شناور در هیرو (Particle Canvas) ----------
  const pCanvas = document.getElementById('particle-canvas');
  if (pCanvas && pCanvas.getContext) {
    const ctx = pCanvas.getContext('2d');
    let w, h, particles;
    function resize() {
      w = pCanvas.width = pCanvas.offsetWidth;
      h = pCanvas.height = pCanvas.offsetHeight;
    }
    function makeParticles() {
      const count = window.innerWidth < 640 ? 22 : 42;
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.8 + 0.6,
        vy: -(Math.random() * 0.35 + 0.08),
        vx: (Math.random() - 0.5) * 0.15,
        a: Math.random() * 0.5 + 0.15
      }));
    }
    resize(); makeParticles();
    window.addEventListener('resize', () => { resize(); makeParticles(); });
    function tick() {
      ctx.clearRect(0, 0, w, h);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.y < -5) { p.y = h + 5; p.x = Math.random() * w; }
        if (p.x < -5) p.x = w + 5; if (p.x > w + 5) p.x = -5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240,217,160,${p.a})`;
        ctx.fill();
      });
      requestAnimationFrame(tick);
    }
    tick();
  }

  // ---------- شمارنده‌ی انیمیشنی برای کارت‌های آماری پنل ادمین ----------
  const adminNums = document.querySelectorAll('.stat-card .num[data-count]');
  adminNums.forEach(el => {
    const target = parseFloat(el.dataset.count);
    if (isNaN(target)) return;
    const duration = 1000;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(eased * target).toLocaleString('fa-IR');
      if (progress < 1) requestAnimationFrame(tick);
      else el.textContent = target.toLocaleString('fa-IR');
    }
    requestAnimationFrame(tick);
  });

  // ---------- کوچک/بزرگ کردن سایدبار پنل ادمین ----------
  const sidebar = document.querySelector('.admin-sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebar && sidebarToggle) {
    if (localStorage.getItem('gu_sidebar_collapsed') === '1') sidebar.classList.add('collapsed');
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('gu_sidebar_collapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
    });
  }

  // ---------- ساعت زنده در هدر پنل ادمین ----------
  const clockEl = document.getElementById('adminClock');
  if (clockEl) {
    const updateClock = () => {
      clockEl.textContent = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    };
    updateClock();
    setInterval(updateClock, 30000);
  }
});

// P4 Premium interactions
(function(){
  const banners=[...document.querySelectorAll('.premium-banner')], dots=[...document.querySelectorAll('.banner-dot')];
  if(banners.length>1){let idx=0,timer; const show=n=>{idx=(n+banners.length)%banners.length;banners.forEach((x,i)=>x.classList.toggle('is-active',i===idx));dots.forEach((x,i)=>x.classList.toggle('active',i===idx));}; const start=()=>{clearInterval(timer);timer=setInterval(()=>show(idx+1),6500)};dots.forEach((d,i)=>d.addEventListener('click',()=>{show(i);start()}));start();}
})();
(function(){
  const el=document.querySelector('[data-admin-live]'); if(!el)return;
  const fmt=n=>Number(n||0).toLocaleString('fa-IR');
  const tick=()=>fetch('/admin/dashboard/live',{headers:{Accept:'application/json'}}).then(r=>r.ok?r.json():null).then(d=>{if(!d)return; Object.entries({revenue:d.revenue,todayRevenue:d.todayRevenue,todayOrders:d.todayOrders,activeUsers:d.activeUsers,pending:d.pending}).forEach(([k,v])=>{const x=el.querySelector(`[data-live="${k}"]`);if(x)x.textContent=fmt(v)}); const st=el.querySelector('[data-live-uptime]');if(st)st.textContent=Math.floor(d.uptime/60)+' دقیقه';}).catch(()=>{});
  tick(); setInterval(tick,15000);
})();
