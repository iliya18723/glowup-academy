function attachUser(db) {
  return (req, res, next) => {
    const sessionUser = req.session.user;
    if (sessionUser?.id) {
      const fresh = db.prepare('SELECT id, full_name, phone, email, avatar, role FROM users WHERE id=?').get(sessionUser.id);
      if (!fresh) {
        return req.session.destroy(() => { res.locals.user = null; res.locals.cartCount = 0; res.locals.currentPath = req.path; next(); });
      }
      // Keep authorization tied to the current DB role, not a stale login-time role.
      req.session.user = { ...sessionUser, id: fresh.id, full_name: fresh.full_name, phone: fresh.phone, email: fresh.email, avatar: fresh.avatar, role: fresh.role };
    }
    res.locals.user = req.session.user || null;
    const courseCart=Array.isArray(req.session.cart)?req.session.cart.length:0;
    const bundleCart=Array.isArray(req.session.bundleCart)?req.session.bundleCart.length:0;
    res.locals.cartCount = courseCart + bundleCart;
    res.locals.currentPath = req.path;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

const ROLE_RANK = { user: 0, support: 1, editor: 2, admin: 3 };
function requireAdmin(req, res, next) {
  if (!req.session.user || ROLE_RANK[req.session.user.role] < ROLE_RANK.editor) {
    return res.status(403).render('403', { title: 'دسترسی غیرمجاز' });
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('403', { title: 'دسترسی غیرمجاز' });
    }
    next();
  };
}
function isAdmin(req) { return req.session.user?.role === 'admin'; }

module.exports = { attachUser, requireAuth, requireAdmin, requireRole, isAdmin };
