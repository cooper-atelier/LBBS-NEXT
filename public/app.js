// ═══ Section 1: Auth & Token Management ═══

const AUTH = {
  getAccessToken: () => localStorage.getItem('accessToken'),
  getRefreshToken: () => localStorage.getItem('refreshToken'),
  setTokens(access, refresh) {
    localStorage.setItem('accessToken', access)
    if (refresh) localStorage.setItem('refreshToken', refresh)
  },
  setUsername(name) { localStorage.setItem('username', name) },
  clear() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('username')
  },
  isLoggedIn: () => !!localStorage.getItem('accessToken'),
  getUser() {
    const token = localStorage.getItem('accessToken')
    if (!token) return null
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      payload.username = localStorage.getItem('username') || '用户'
      return payload
    } catch { return null }
  }
}

// ═══ Section 2: API Client ═══

let isRefreshing = false

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers }
  const token = AUTH.getAccessToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res = await fetch(`/api${path}`, { ...options, headers })

  // Auto-refresh on 401 (坑2 fix: exclude /auth/refresh from retry)
  if (res.status === 401 && AUTH.getRefreshToken() && path !== '/auth/refresh' && !isRefreshing) {
    isRefreshing = true
    try {
      const refreshRes = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: AUTH.getRefreshToken() })
      })
      if (refreshRes.ok) {
        const { accessToken } = await refreshRes.json()
        AUTH.setTokens(accessToken)
        headers['Authorization'] = `Bearer ${accessToken}`
        res = await fetch(`/api${path}`, { ...options, headers })
        reconnectSocket()
      } else {
        AUTH.clear()
        navigate('/login')
        throw new Error('Session expired')
      }
    } finally {
      isRefreshing = false
    }
  }

  return res
}

// ═══ Section 3: Router ═══

const ROUTES = [
  { pattern: /^\/$/, render: renderBoardList },
  { pattern: /^\/login$/, render: renderLogin },
  { pattern: /^\/register$/, render: renderRegister },
  { pattern: /^\/boards\/(\d+)$/, render: renderPostList },
  { pattern: /^\/posts\/(\d+)$/, render: renderPostDetail },
  { pattern: /^\/profile$/, render: renderProfile },
  { pattern: /^\/agents$/, render: renderMyAgents },
  { pattern: /^\/admin$/, render: renderAdmin },
]

let currentRoute = null

function navigate(path) {
  history.pushState(null, '', path)
  routeTo(path)
}

function routeTo(path) {
  const clean = path.split('?')[0]
  for (const route of ROUTES) {
    const match = clean.match(route.pattern)
    if (match) {
      currentRoute = { path: clean, params: match.slice(1) }
      route.render(...match.slice(1))
      return
    }
  }
  renderNotFound()
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-route]')
  if (a) {
    e.preventDefault()
    navigate(a.getAttribute('href'))
  }
})

window.addEventListener('popstate', () => routeTo(location.pathname))

// ═══ Section 4: Utility Functions ═══

const $ = (id) => document.getElementById(id)

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

function showAlert(container, message, type = 'error') {
  const existing = container.querySelector('.alert')
  if (existing) existing.remove()
  const div = document.createElement('div')
  div.className = `alert alert-${type}`
  div.setAttribute('role', 'alert')
  div.textContent = message
  container.prepend(div)
}

function canModify(authorId, user) {
  if (!user) return false
  return user.sub === authorId || user.role === 'admin'
}

function extractMentionNames(text) {
  const matches = text.match(/@([a-zA-Z0-9_]+)/g)
  if (!matches) return []
  return matches.map(m => m.slice(1))
}

function showAiThinking(names) {
  const tree = $('comment-tree')
  if (!tree) return
  names.forEach(name => {
    const safe = CSS.escape(name)
    if (tree.querySelector(`.ai-thinking[data-agent="${safe}"]`)) return
    tree.insertAdjacentHTML('beforeend',
      `<p class="ai-thinking" data-agent="${escapeHtml(name)}">@${escapeHtml(name)} 正在思考中...</p>`
    )
  })
}

function updateNav() {
  const nav = $('nav-right')
  const user = AUTH.getUser()
  if (user) {
    nav.innerHTML = `
      <li><a href="/agents" data-route>我的AI</a></li>
      ${user.role === 'admin' ? '<li><a href="/admin" data-route>管理</a></li>' : ''}
      <li><a href="/profile" data-route>${escapeHtml(user.username)}</a></li>
      <li><a href="#" id="logout-btn">退出</a></li>
    `
    $('logout-btn').addEventListener('click', async (e) => {
      e.preventDefault()
      await api('/auth/logout', { method: 'POST' }).catch(() => {})
      AUTH.clear()
      disconnectSocket()
      updateNav()
      navigate('/login')
    })
  } else {
    nav.innerHTML = `
      <li><a href="/login" data-route>登录</a></li>
      <li><a href="/register" data-route>注册</a></li>
    `
  }
}

// ═══ Section 5: Page Renderers ═══

function renderBoardList() {
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'
  api('/boards').then(async (res) => {
    if (!res.ok) {
      $('app').innerHTML = '<p>加载版块失败</p>'
      return
    }
    const boards = await res.json()
    if (boards.length === 0) {
      $('app').innerHTML = '<div class="empty-state"><p>还没有版块</p></div>'
      return
    }
    $('app').innerHTML = `
      <h2>版块列表</h2>
      <div class="board-list">
        ${boards.map(b => `
          <article>
            <a href="/boards/${b.id}" data-route>
              <strong>${escapeHtml(b.name)}</strong>
            </a>
            ${b.description ? `<p>${escapeHtml(b.description)}</p>` : ''}
          </article>
        `).join('')}
      </div>
    `
  })
}

function renderLogin() {
  if (AUTH.isLoggedIn()) { navigate('/'); return }
  $('app').innerHTML = `
    <article style="max-width:420px;margin:2rem auto">
      <h2>登录</h2>
      <form id="login-form">
        <label for="login-username">用户名</label>
        <input id="login-username" name="username" type="text" required autocomplete="username">
        <label for="login-password">密码</label>
        <input id="login-password" name="password" type="password" required autocomplete="current-password">
        <button type="submit">登录</button>
      </form>
      <p>还没有账号？<a href="/register" data-route>注册</a></p>
    </article>
  `
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button')
    btn.setAttribute('aria-busy', 'true')
    btn.disabled = true
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('login-username').value.trim(),
          password: $('login-password').value,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        showAlert($('app').querySelector('article'), data.message || '登录失败')
        return
      }
      AUTH.setTokens(data.accessToken, data.refreshToken)
      // Fetch username from /users/me since JWT doesn't include it
      const meRes = await api('/users/me')
      if (meRes.ok) {
        const me = await meRes.json()
        AUTH.setUsername(me.username)
      }
      updateNav()
      connectSocket()
      navigate('/')
    } catch (err) {
      showAlert($('app').querySelector('article'), '网络错误，请重试')
    } finally {
      btn.removeAttribute('aria-busy')
      btn.disabled = false
    }
  })
}

function renderRegister() {
  if (AUTH.isLoggedIn()) { navigate('/'); return }
  $('app').innerHTML = `
    <article style="max-width:420px;margin:2rem auto">
      <h2>注册</h2>
      <form id="register-form">
        <label for="reg-username">用户名</label>
        <input id="reg-username" name="username" type="text" required autocomplete="username"
               pattern="^[a-zA-Z0-9_]+$" minlength="2" maxlength="30"
               title="2-30位，仅限字母、数字和下划线">
        <label for="reg-email">邮箱</label>
        <input id="reg-email" name="email" type="email" required autocomplete="email" maxlength="255">
        <label for="reg-password">密码</label>
        <input id="reg-password" name="password" type="password" required autocomplete="new-password"
               minlength="6" maxlength="128">
        <button type="submit">注册</button>
      </form>
      <p>已有账号？<a href="/login" data-route>登录</a></p>
    </article>
  `
  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button')
    btn.setAttribute('aria-busy', 'true')
    btn.disabled = true
    try {
      const res = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: $('reg-username').value.trim(),
          email: $('reg-email').value.trim(),
          password: $('reg-password').value,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        showAlert($('app').querySelector('article'), data.message || '注册失败')
        return
      }
      showAlert($('app').querySelector('article'), '注册成功，请登录', 'success')
      setTimeout(() => navigate('/login'), 1000)
    } catch (err) {
      showAlert($('app').querySelector('article'), '网络错误，请重试')
    } finally {
      btn.removeAttribute('aria-busy')
      btn.disabled = false
    }
  })
}

function renderPostList(boardId) {
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'
  joinBoard(boardId)

  let nextCursor = null

  async function loadPosts(cursor) {
    const qs = cursor ? `?cursor=${cursor}` : ''
    const res = await api(`/boards/${boardId}/posts${qs}`)
    if (!res.ok) {
      if (!cursor) $('app').innerHTML = '<p>加载帖子失败</p>'
      return
    }
    const data = await res.json()
    nextCursor = data.nextCursor

    if (!cursor) {
      // First load — render full page
      const boardRes = await api(`/boards`)
      const boards = boardRes.ok ? await boardRes.json() : []
      const board = boards.find(b => b.id === Number(boardId))
      const boardName = board ? escapeHtml(board.name) : `版块 #${boardId}`

      $('app').innerHTML = `
        <p><a href="/" data-route>← 返回版块列表</a></p>
        <h2>${boardName}</h2>
        ${AUTH.isLoggedIn() ? `<button id="new-post-btn">发帖</button>` : ''}
        <div id="post-list"></div>
        ${nextCursor ? '<button id="load-more-btn">加载更多</button>' : ''}
      `
      if (AUTH.isLoggedIn()) {
        $('new-post-btn').addEventListener('click', () => renderNewPostForm(boardId))
      }
    }

    const container = $('post-list')
    if (data.posts.length === 0 && !cursor) {
      container.innerHTML = '<div class="empty-state"><p>还没有帖子，来发第一帖吧</p></div>'
      return
    }

    const html = data.posts.map(p => `
      <article>
        <header>
          <a href="/posts/${p.id}" data-route><strong>${escapeHtml(p.title)}</strong></a>
        </header>
        <p class="meta">
          ${p.agent_id ? `<span class="ai-badge">AI</span> ${escapeHtml(p.agent_name || '')} ` : ''}
          ${escapeHtml(p.author_username)} · ${timeAgo(p.created_at)}
        </p>
      </article>
    `).join('')
    container.insertAdjacentHTML('beforeend', html)

    // Update load more button
    const oldBtn = $('load-more-btn')
    if (oldBtn) oldBtn.remove()
    if (nextCursor) {
      const btn = document.createElement('button')
      btn.id = 'load-more-btn'
      btn.className = 'outline'
      btn.textContent = '加载更多'
      btn.addEventListener('click', () => {
        btn.setAttribute('aria-busy', 'true')
        loadPosts(nextCursor)
      })
      $('app').appendChild(btn)
    }
  }

  loadPosts(null)
}

function renderNewPostForm(boardId) {
  const container = $('post-list')
  const existing = $('new-post-form')
  if (existing) { existing.remove(); return }

  const form = document.createElement('article')
  form.id = 'new-post-form'
  form.innerHTML = `
    <h3>发新帖</h3>
    <form>
      <label for="post-title">标题</label>
      <input id="post-title" type="text" required minlength="1" maxlength="200">
      <label for="post-content">内容</label>
      <textarea id="post-content" required minlength="1" maxlength="50000" rows="5"></textarea>
      <small>提示：输入 @AgentName 可以召唤 AI 回复</small>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <button type="submit">发布</button>
        <button type="button" class="outline" id="cancel-post-btn">取消</button>
      </div>
    </form>
  `
  container.parentNode.insertBefore(form, container)

  $('cancel-post-btn').addEventListener('click', () => form.remove())

  form.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button[type="submit"]')
    btn.setAttribute('aria-busy', 'true')
    btn.disabled = true
    try {
      const res = await api(`/boards/${boardId}/posts`, {
        method: 'POST',
        body: JSON.stringify({
          title: $('post-title').value.trim(),
          content: $('post-content').value.trim(),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        showAlert(form, data.message || '发帖失败')
        return
      }
      // Refresh the post list
      renderPostList(boardId)
    } catch {
      showAlert(form, '网络错误，请重试')
    } finally {
      btn.removeAttribute('aria-busy')
      btn.disabled = false
    }
  })
}

function renderPostDetail(postId) {
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'

  api(`/posts/${postId}`).then(async (res) => {
    if (!res.ok) {
      $('app').innerHTML = '<p>帖子不存在或加载失败</p>'
      return
    }
    const post = await res.json()
    const user = AUTH.getUser()
    joinBoard(post.board_id)

    const authorLabel = post.agent_id
      ? `<span class="ai-badge">AI</span> ${escapeHtml(post.agent_name || '')} <small>(by ${escapeHtml(post.author_username)})</small>`
      : escapeHtml(post.author_username)

    $('app').innerHTML = `
      <p><a href="/boards/${post.board_id}" data-route>← 返回帖子列表</a></p>
      <article id="post-article">
        <header>
          <h2 id="post-title-display">${escapeHtml(post.title)}</h2>
          <p class="meta">${authorLabel} · ${timeAgo(post.created_at)}</p>
        </header>
        <div class="post-content" id="post-content-display">${escapeHtml(post.content).replace(/\n/g, '<br>')}</div>
        ${!post.is_deleted && canModify(post.author_id, user) ? `
          <footer style="display:flex;gap:0.5rem">
            <button class="outline" id="edit-post-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem">编辑</button>
            <button class="outline" id="delete-post-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem;color:var(--pico-del-color)">删除</button>
          </footer>
        ` : ''}
      </article>
      <hr>
      <h3>评论 (${post.comments.length})</h3>
      ${user ? `
        <form id="comment-form">
          <textarea id="comment-content" required minlength="1" maxlength="10000" rows="3" placeholder="写评论... 输入 @AgentName 召唤 AI"></textarea>
          <button type="submit">发表评论</button>
        </form>
      ` : '<p><a href="/login" data-route>登录后参与评论</a></p>'}
      <div id="comment-tree">${renderCommentTree(post.comments, postId, user)}</div>
    `

    if (user) {
      $('comment-form').addEventListener('submit', async (e) => {
        e.preventDefault()
        const btn = e.target.querySelector('button')
        btn.setAttribute('aria-busy', 'true')
        btn.disabled = true
        try {
          const content = $('comment-content').value.trim()
          const mentions = extractMentionNames(content)
          const res = await api(`/posts/${postId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ content }),
          })
          if (!res.ok) {
            const data = await res.json()
            showAlert($('comment-form'), data.message || '评论失败')
            return
          }
          renderPostDetail(postId)
          if (mentions.length) showAiThinking(mentions)
        } catch {
          showAlert($('comment-form'), '网络错误，请重试')
        } finally {
          btn.removeAttribute('aria-busy')
          btn.disabled = false
        }
      })
    }

    bindReplyForms(postId)
    bindCommentActions(postId)

    if ($('edit-post-btn')) {
      $('edit-post-btn').addEventListener('click', () => {
        const article = $('post-article')
        const titleEl = $('post-title-display')
        const contentEl = $('post-content-display')
        const footer = article.querySelector('footer')
        titleEl.outerHTML = `<input id="edit-post-title" type="text" value="${escapeHtml(post.title)}" maxlength="200">`
        contentEl.outerHTML = `<textarea id="edit-post-content" rows="6" maxlength="50000">${escapeHtml(post.content)}</textarea>`
        footer.innerHTML = `
          <button id="save-post-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem">保存</button>
          <button class="outline" id="cancel-edit-post-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem">取消</button>
        `
        $('cancel-edit-post-btn').addEventListener('click', () => renderPostDetail(postId))
        $('save-post-btn').addEventListener('click', async () => {
          const btn = $('save-post-btn')
          btn.setAttribute('aria-busy', 'true')
          btn.disabled = true
          try {
            const res = await api(`/posts/${postId}`, {
              method: 'PATCH',
              body: JSON.stringify({
                title: $('edit-post-title').value.trim(),
                content: $('edit-post-content').value.trim(),
              }),
            })
            if (!res.ok) {
              const data = await res.json()
              showAlert(article, data.message || '编辑失败')
              return
            }
            renderPostDetail(postId)
          } catch {
            showAlert(article, '网络错误，请重试')
          } finally {
            btn.removeAttribute('aria-busy')
            btn.disabled = false
          }
        })
      })
    }

    if ($('delete-post-btn')) {
      $('delete-post-btn').addEventListener('click', async () => {
        if (!confirm('确定要删除这篇帖子吗？')) return
        const btn = $('delete-post-btn')
        btn.setAttribute('aria-busy', 'true')
        btn.disabled = true
        try {
          const res = await api(`/posts/${postId}`, { method: 'DELETE' })
          if (!res.ok) {
            const data = await res.json()
            showAlert($('post-article'), data.message || '删除失败')
            return
          }
          navigate(`/boards/${post.board_id}`)
        } catch {
          showAlert($('post-article'), '网络错误，请重试')
        } finally {
          btn.removeAttribute('aria-busy')
          btn.disabled = false
        }
      })
    }
  })
}

function renderCommentTree(comments, postId, user) {
  const topLevel = comments.filter(c => c.parent_id === null)
  if (topLevel.length === 0) return '<div class="empty-state"><p>暂无评论</p></div>'

  return topLevel.map(c => {
    const replies = comments.filter(r => r.parent_id === c.id)
    return `
      <article class="comment ${c.agent_id ? 'ai-comment' : ''} ${c.is_deleted ? 'deleted' : ''}" data-comment-id="${c.id}">
        ${renderCommentHeader(c)}
        <p class="comment-body">${c.is_deleted ? c.content : escapeHtml(c.content).replace(/\n/g, '<br>')}</p>
        ${!c.is_deleted ? `<div class="comment-actions" style="display:flex;gap:0.3rem">
          ${user ? `<button class="outline reply-btn" data-parent="${c.id}" style="padding:0.2rem 0.6rem;font-size:0.8rem">回复</button>` : ''}
          ${canModify(c.author_id, user) ? `
            <button class="outline edit-comment-btn" data-id="${c.id}" data-content="${escapeHtml(c.content)}" style="padding:0.2rem 0.6rem;font-size:0.8rem">编辑</button>
            <button class="outline delete-comment-btn" data-id="${c.id}" style="padding:0.2rem 0.6rem;font-size:0.8rem;color:var(--pico-del-color)">删除</button>
          ` : ''}
        </div>` : ''}
        <div class="reply-form-slot" id="reply-slot-${c.id}"></div>
        ${replies.length > 0 ? `
          <div class="replies">
            ${replies.map(r => `
              <article class="comment reply ${r.agent_id ? 'ai-comment' : ''} ${r.is_deleted ? 'deleted' : ''}" data-comment-id="${r.id}">
                ${renderCommentHeader(r)}
                <p class="comment-body">${r.is_deleted ? r.content : escapeHtml(r.content).replace(/\n/g, '<br>')}</p>
                ${!r.is_deleted && canModify(r.author_id, user) ? `<div class="comment-actions" style="display:flex;gap:0.3rem">
                  <button class="outline edit-comment-btn" data-id="${r.id}" data-content="${escapeHtml(r.content)}" style="padding:0.2rem 0.6rem;font-size:0.8rem">编辑</button>
                  <button class="outline delete-comment-btn" data-id="${r.id}" style="padding:0.2rem 0.6rem;font-size:0.8rem;color:var(--pico-del-color)">删除</button>
                </div>` : ''}
              </article>
            `).join('')}
          </div>
        ` : ''}
      </article>
    `
  }).join('')
}

function renderCommentHeader(c) {
  const authorLabel = c.agent_id
    ? `<span class="ai-badge">AI</span> ${escapeHtml(c.agent_name || '')} <small>(by ${escapeHtml(c.author_username)})</small>`
    : escapeHtml(c.author_username)
  return `<div class="comment-header meta">${authorLabel} · ${timeAgo(c.created_at)}</div>`
}

function bindReplyForms(postId) {
  document.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const parentId = btn.dataset.parent
      const slot = $(`reply-slot-${parentId}`)
      if (slot.querySelector('form')) { slot.innerHTML = ''; return }
      slot.innerHTML = `
        <form class="reply-form">
          <textarea required minlength="1" maxlength="10000" rows="2" placeholder="回复..."></textarea>
          <div style="display:flex;gap:0.5rem;margin-top:0.3rem">
            <button type="submit" style="padding:0.2rem 0.6rem;font-size:0.8rem">发送</button>
            <button type="button" class="outline cancel-reply" style="padding:0.2rem 0.6rem;font-size:0.8rem">取消</button>
          </div>
        </form>
      `
      slot.querySelector('.cancel-reply').addEventListener('click', () => { slot.innerHTML = '' })
      slot.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault()
        const submitBtn = e.target.querySelector('button[type="submit"]')
        submitBtn.setAttribute('aria-busy', 'true')
        submitBtn.disabled = true
        try {
          const content = e.target.querySelector('textarea').value.trim()
          const mentions = extractMentionNames(content)
          const res = await api(`/posts/${postId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ content, parent_id: Number(parentId) }),
          })
          if (!res.ok) {
            const data = await res.json()
            showAlert(slot, data.message || '回复失败')
            return
          }
          renderPostDetail(postId)
          if (mentions.length) showAiThinking(mentions)
        } catch {
          showAlert(slot, '网络错误，请重试')
        } finally {
          submitBtn.removeAttribute('aria-busy')
          submitBtn.disabled = false
        }
      })
    })
  })
}

function bindCommentActions(postId) {
  document.querySelectorAll('.edit-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const article = btn.closest('article[data-comment-id]')
      const body = article.querySelector('.comment-body')
      const actions = article.querySelector('.comment-actions')
      const original = btn.dataset.content

      body.outerHTML = `<textarea class="edit-comment-textarea" rows="3" maxlength="10000">${escapeHtml(original)}</textarea>`
      actions.innerHTML = `
        <button class="save-comment-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem">保存</button>
        <button class="outline cancel-comment-edit-btn" style="padding:0.2rem 0.6rem;font-size:0.8rem">取消</button>
      `
      article.querySelector('.cancel-comment-edit-btn').addEventListener('click', () => renderPostDetail(postId))
      article.querySelector('.save-comment-btn').addEventListener('click', async () => {
        const saveBtn = article.querySelector('.save-comment-btn')
        saveBtn.setAttribute('aria-busy', 'true')
        saveBtn.disabled = true
        try {
          const content = article.querySelector('.edit-comment-textarea').value.trim()
          const res = await api(`/comments/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ content }),
          })
          if (!res.ok) {
            const data = await res.json()
            showAlert(article, data.message || '编辑失败')
            return
          }
          renderPostDetail(postId)
        } catch {
          showAlert(article, '网络错误，请重试')
        } finally {
          saveBtn.removeAttribute('aria-busy')
          saveBtn.disabled = false
        }
      })
    })
  })

  document.querySelectorAll('.delete-comment-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定要删除这条评论吗？')) return
      const id = btn.dataset.id
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api(`/comments/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          const data = await res.json()
          const article = btn.closest('article[data-comment-id]')
          showAlert(article, data.message || '删除失败')
          return
        }
        renderPostDetail(postId)
      } catch {
        const article = btn.closest('article[data-comment-id]')
        showAlert(article, '网络错误，请重试')
      } finally {
        btn.removeAttribute('aria-busy')
        btn.disabled = false
      }
    })
  })
}

function renderProfile() {
  if (!AUTH.isLoggedIn()) { navigate('/login'); return }
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'

  api('/users/me').then(async (res) => {
    if (!res.ok) {
      $('app').innerHTML = '<p>加载个人资料失败</p>'
      return
    }
    const me = await res.json()

    $('app').innerHTML = `
      <article style="max-width:500px;margin:2rem auto">
        <h2>个人资料</h2>
        <dl>
          <dt>用户名</dt><dd>${escapeHtml(me.username)}</dd>
          <dt>邮箱</dt><dd>${escapeHtml(me.email)}</dd>
          <dt>注册时间</dt><dd>${new Date(me.created_at).toLocaleDateString('zh-CN')}</dd>
        </dl>
        <hr>
        <form id="profile-form">
          <label for="profile-avatar">头像 URL</label>
          <input id="profile-avatar" type="text" maxlength="500" value="${escapeHtml(me.avatar_url || '')}" placeholder="https://example.com/avatar.png">
          <label for="profile-bio">个人简介</label>
          <textarea id="profile-bio" maxlength="500" rows="3" placeholder="介绍一下自己...">${escapeHtml(me.bio || '')}</textarea>
          <button type="submit">保存</button>
        </form>
      </article>
    `

    $('profile-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = e.target.querySelector('button')
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api('/users/me', {
          method: 'PATCH',
          body: JSON.stringify({
            avatar_url: $('profile-avatar').value.trim() || undefined,
            bio: $('profile-bio').value.trim() || undefined,
          }),
        })
        if (!res.ok) {
          const data = await res.json()
          showAlert($('profile-form'), data.message || '保存失败')
          return
        }
        showAlert($('profile-form'), '保存成功', 'success')
      } catch {
        showAlert($('profile-form'), '网络错误，请重试')
      } finally {
        btn.removeAttribute('aria-busy')
        btn.disabled = false
      }
    })
  })
}

function renderMyAgents() {
  if (!AUTH.isLoggedIn()) { navigate('/login'); return }
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'

  api('/agents/mine').then(async (res) => {
    if (!res.ok) {
      $('app').innerHTML = '<p>加载 Agent 列表失败</p>'
      return
    }
    const { agents } = await res.json()

    $('app').innerHTML = `
      <h2>我的 AI Agent</h2>
      <button id="create-agent-btn">创建 Agent</button>
      <div id="agent-create-slot"></div>
      <div id="one-time-secrets"></div>
      <div id="agent-list">
        ${agents.length === 0 ? '<div class="empty-state"><p>还没有 Agent，创建一个吧</p></div>' : agents.map(a => renderAgentCard(a)).join('')}
      </div>
    `

    $('create-agent-btn').addEventListener('click', () => {
      const slot = $('agent-create-slot')
      if (slot.querySelector('form')) { slot.innerHTML = ''; return }
      slot.innerHTML = renderAgentForm()
      bindAgentFormEvents(slot, null)
    })

    bindAgentCardEvents()
  })
}

function renderAgentCard(a) {
  return `
    <article class="agent-card" data-agent-id="${a.id}">
      <div class="agent-header">
        <strong>${escapeHtml(a.name)}</strong>
        <span class="meta">${a.is_active ? '✅ 活跃' : '⏸ 已停用'} · ${escapeHtml(a.model_type)}</span>
      </div>
      <p class="meta">
        模型: ${escapeHtml(a.model_name || '默认')}
        ${a.webhook_url ? ` · Webhook: ${escapeHtml(a.webhook_url)}` : ''}
      </p>
      ${a.system_prompt ? `<details><summary class="meta">系统提示词</summary><p style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(a.system_prompt)}</p></details>` : ''}
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
        <button class="outline toggle-agent-btn" data-id="${a.id}" data-active="${a.is_active ? 1 : 0}" style="padding:0.2rem 0.6rem;font-size:0.8rem">
          ${a.is_active ? '停用' : '启用'}
        </button>
        <button class="outline rotate-token-btn" data-id="${a.id}" style="padding:0.2rem 0.6rem;font-size:0.8rem">重置 Token</button>
        <button class="outline delete-agent-btn" data-id="${a.id}" style="padding:0.2rem 0.6rem;font-size:0.8rem;color:var(--pico-del-color)">删除</button>
      </div>
    </article>
  `
}

function renderAgentForm(agent) {
  const isEdit = !!agent
  const mt = agent?.model_type || 'openai'
  return `
    <article>
      <h3>${isEdit ? '编辑 Agent' : '创建 Agent'}</h3>
      <form id="${isEdit ? 'edit-agent-form' : 'create-agent-form'}">
        <label for="agent-name">名称 <small>(字母、数字、下划线，用于 @提及)</small></label>
        <input id="agent-name" type="text" required pattern="^[a-zA-Z0-9_]+$" minlength="1" maxlength="32"
               value="${isEdit ? escapeHtml(agent.name) : ''}" ${isEdit ? 'disabled' : ''}>
        <label for="agent-model-type">模型类型</label>
        <select id="agent-model-type" required>
          <option value="openai" ${mt === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="anthropic" ${mt === 'anthropic' ? 'selected' : ''}>Anthropic</option>
          <option value="custom_webhook" ${mt === 'custom_webhook' ? 'selected' : ''}>自定义 Webhook</option>
        </select>
        <label for="agent-model-name">模型名称 <small>(可选)</small></label>
        <input id="agent-model-name" type="text" maxlength="100" value="${isEdit ? escapeHtml(agent.model_name || '') : ''}" placeholder="如 gpt-4o, claude-sonnet-4-20250514">
        <div id="agent-api-key-field" ${mt === 'custom_webhook' ? 'style="display:none"' : ''}>
          <label for="agent-base-url">Base URL <small>(可选，兼容 OpenAI 格式的自定义端点)</small></label>
          <input id="agent-base-url" type="url" maxlength="500" value="${isEdit && agent.base_url ? escapeHtml(agent.base_url) : ''}" placeholder="如 https://api.openai.com/v1">
          <label for="agent-api-key">API Key</label>
          <input id="agent-api-key" type="password" maxlength="500" placeholder="${isEdit ? '留空则不修改' : ''}">
        </div>
        <div id="agent-webhook-field" ${mt !== 'custom_webhook' ? 'style="display:none"' : ''}>
          <label for="agent-webhook-url">Webhook URL</label>
          <input id="agent-webhook-url" type="url" maxlength="500" value="${isEdit && agent.webhook_url ? escapeHtml(agent.webhook_url) : ''}">
        </div>
        <label for="agent-prompt">系统提示词 <small>(可选)</small></label>
        <textarea id="agent-prompt" maxlength="4000" rows="3">${isEdit ? escapeHtml(agent.system_prompt || '') : ''}</textarea>
        <div style="display:flex;gap:0.5rem">
          <button type="submit" style="flex:2">${isEdit ? '保存' : '创建'}</button>
          <button type="button" class="outline cancel-agent-form" style="flex:1">取消</button>
        </div>
      </form>
    </article>
  `
}

function bindAgentFormEvents(container, agentId) {
  const typeSelect = container.querySelector('#agent-model-type')
  typeSelect.addEventListener('change', () => {
    const isWebhook = typeSelect.value === 'custom_webhook'
    container.querySelector('#agent-api-key-field').style.display = isWebhook ? 'none' : ''
    container.querySelector('#agent-webhook-field').style.display = isWebhook ? '' : 'none'
  })

  container.querySelector('.cancel-agent-form').addEventListener('click', () => {
    container.innerHTML = ''
  })

  container.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button[type="submit"]')
    btn.setAttribute('aria-busy', 'true')
    btn.disabled = true

    const body = {
      model_type: $('agent-model-type').value,
      model_name: $('agent-model-name').value.trim() || undefined,
      system_prompt: $('agent-prompt').value.trim() || undefined,
    }

    const isWebhook = body.model_type === 'custom_webhook'
    if (!isWebhook) {
      const key = $('agent-api-key').value.trim()
      if (key || !agentId) body.api_key = key
      const baseUrl = $('agent-base-url').value.trim()
      if (baseUrl) body.base_url = baseUrl
    } else {
      body.webhook_url = $('agent-webhook-url').value.trim() || undefined
    }

    if (!agentId) {
      body.name = $('agent-name').value.trim()
    }

    try {
      const url = agentId ? `/agents/${agentId}` : '/agents'
      const method = agentId ? 'PATCH' : 'POST'
      const res = await api(url, { method, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) {
        showAlert(container.querySelector('article'), data.message || '操作失败')
        return
      }

      // Show one-time secrets for new agents
      if (!agentId && data.raw_token) {
        const secrets = $('one-time-secrets')
        secrets.innerHTML = `
          <article style="background:var(--pico-code-background-color)">
            <h4>⚠️ 请保存以下信息（仅显示一次）</h4>
            <label>Agent Token</label>
            <div class="token-display">${escapeHtml(data.raw_token)}</div>
            ${data.webhook_secret ? `
              <label style="margin-top:0.5rem">Webhook Secret</label>
              <div class="token-display">${escapeHtml(data.webhook_secret)}</div>
            ` : ''}
            <button class="outline" style="margin-top:0.5rem" onclick="this.closest('article').remove()">我已保存，关闭</button>
          </article>
        `
      }

      renderMyAgents()
    } catch {
      showAlert(container.querySelector('article'), '网络错误，请重试')
    } finally {
      btn.removeAttribute('aria-busy')
      btn.disabled = false
    }
  })
}

function bindAgentCardEvents() {
  document.querySelectorAll('.toggle-agent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const isActive = btn.dataset.active === '1'
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api(`/agents/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ is_active: !isActive }),
        })
        if (!res.ok) {
          const data = await res.json()
          alert(data.message || '操作失败')
          return
        }
        renderMyAgents()
      } catch {
        alert('网络错误，请重试')
      }
    })
  })

  document.querySelectorAll('.rotate-token-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('重置 Token 后旧 Token 将立即失效，确定继续？')) return
      const id = btn.dataset.id
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api(`/agents/${id}/rotate-token`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) {
          alert(data.message || '操作失败')
          return
        }
        const secrets = $('one-time-secrets')
        secrets.innerHTML = `
          <article style="background:var(--pico-code-background-color)">
            <h4>⚠️ 新 Token（仅显示一次）</h4>
            <div class="token-display">${escapeHtml(data.raw_token)}</div>
            <button class="outline" style="margin-top:0.5rem" onclick="this.closest('article').remove()">我已保存，关闭</button>
          </article>
        `
      } catch {
        alert('网络错误，请重试')
      } finally {
        btn.removeAttribute('aria-busy')
        btn.disabled = false
      }
    })
  })

  document.querySelectorAll('.delete-agent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('删除后 Agent 将无法恢复（软删除），确定继续？')) return
      const id = btn.dataset.id
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api(`/agents/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          const data = await res.json()
          alert(data.message || '删除失败')
          return
        }
        renderMyAgents()
      } catch {
        alert('网络错误，请重试')
      }
    })
  })
}

function renderAdmin() {
  const user = AUTH.getUser()
  if (!user || user.role !== 'admin') { navigate('/'); return }
  $('app').innerHTML = '<p aria-busy="true">加载中...</p>'

  let activeTab = 'agents'

  function renderTabs() {
    $('app').innerHTML = `
      <h2>管理面板</h2>
      <div class="tabs">
        <button class="${activeTab === 'boards' ? 'active' : ''}" data-tab="boards">板块管理</button>
        <button class="${activeTab === 'agents' ? 'active' : ''}" data-tab="agents">公共 AI Agent</button>
        <button class="${activeTab === 'users' ? 'active' : ''}" data-tab="users">用户管理</button>
      </div>
      <div id="admin-content"></div>
    `
    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab
        renderTabs()
      })
    })

    if (activeTab === 'boards') renderAdminBoards()
    else if (activeTab === 'agents') renderAdminAgents()
    else renderAdminUsers()
  }

  renderTabs()
}

async function renderAdminBoards() {
  const container = $('admin-content')
  container.innerHTML = '<p aria-busy="true">加载中...</p>'

  const res = await api('/boards')
  if (!res.ok) {
    container.innerHTML = '<p>加载板块失败</p>'
    return
  }
  const boards = await res.json()

  container.innerHTML = `
    <button id="admin-create-board-btn" style="margin-bottom:1rem">新建板块</button>
    <div id="admin-board-form-slot"></div>
    <div id="admin-board-list">
      ${boards.length === 0 ? '<div class="empty-state"><p>暂无板块</p></div>' : boards.map(b => `
        <article>
          <strong>${escapeHtml(b.name)}</strong>
          ${b.description ? `<p class="meta">${escapeHtml(b.description)}</p>` : ''}
        </article>
      `).join('')}
    </div>
  `

  $('admin-create-board-btn').addEventListener('click', () => {
    const slot = $('admin-board-form-slot')
    if (slot.querySelector('form')) { slot.innerHTML = ''; return }
    slot.innerHTML = `
      <article>
        <h3>新建板块</h3>
        <form id="admin-board-form">
          <label for="admin-board-name">板块名称</label>
          <input id="admin-board-name" type="text" required maxlength="100">
          <label for="admin-board-desc">描述 <small>(可选)</small></label>
          <input id="admin-board-desc" type="text" maxlength="500">
          <div style="display:flex;gap:0.5rem">
            <button type="submit" style="flex:2">创建</button>
            <button type="button" class="outline" id="admin-cancel-board" style="flex:1">取消</button>
          </div>
        </form>
      </article>
    `
    $('admin-cancel-board').addEventListener('click', () => { slot.innerHTML = '' })
    $('admin-board-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = e.target.querySelector('button[type="submit"]')
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api('/boards', {
          method: 'POST',
          body: JSON.stringify({
            name: $('admin-board-name').value.trim(),
            description: $('admin-board-desc').value.trim() || undefined,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          showAlert(slot.querySelector('article'), data.message || '创建失败')
          return
        }
        renderAdminBoards()
      } catch {
        showAlert(slot.querySelector('article'), '网络错误，请重试')
      } finally {
        btn.removeAttribute('aria-busy')
        btn.disabled = false
      }
    })
  })
}

async function renderAdminAgents() {
  const container = $('admin-content')
  container.innerHTML = '<p aria-busy="true">加载中...</p>'

  const res = await api('/admin/agents')
  if (!res.ok) {
    container.innerHTML = '<p>加载失败</p>'
    return
  }
  const { agents } = await res.json()

  container.innerHTML = `
    <button id="admin-create-agent-btn" style="margin-bottom:1rem">创建公共 Agent</button>
    <div id="admin-agent-form-slot"></div>
    <div id="admin-one-time-secrets"></div>
    <div id="admin-agent-list">
      ${agents.length === 0 ? '<div class="empty-state"><p>暂无公共 Agent</p></div>' : agents.map(a => `
        <article class="agent-card" data-agent-id="${a.id}">
          <div class="agent-header">
            <strong>${escapeHtml(a.name)}</strong>
            <span class="meta">${a.is_active ? '✅ 活跃' : '⏸ 已停用'} · ${escapeHtml(a.model_type)}</span>
          </div>
          <p class="meta">
            模型: ${escapeHtml(a.model_name || '默认')}
            ${a.webhook_url ? ` · Webhook: ${escapeHtml(a.webhook_url)}` : ''}
          </p>
          ${a.system_prompt ? `<details><summary class="meta">系统提示词</summary><p style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(a.system_prompt)}</p></details>` : ''}
          <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
            <button class="outline admin-toggle-agent" data-id="${a.id}" data-active="${a.is_active ? 1 : 0}" style="padding:0.2rem 0.6rem;font-size:0.8rem">
              ${a.is_active ? '停用' : '启用'}
            </button>
          </div>
        </article>
      `).join('')}
    </div>
  `

  $('admin-create-agent-btn').addEventListener('click', () => {
    const slot = $('admin-agent-form-slot')
    if (slot.querySelector('form')) { slot.innerHTML = ''; return }
    slot.innerHTML = renderAdminAgentForm()
    bindAdminAgentFormEvents(slot)
  })

  document.querySelectorAll('.admin-toggle-agent').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const isActive = btn.dataset.active === '1'
      btn.setAttribute('aria-busy', 'true')
      btn.disabled = true
      try {
        const res = await api(`/admin/agents/${id}/toggle`, {
          method: 'PATCH',
          body: JSON.stringify({ is_active: !isActive }),
        })
        if (!res.ok) {
          const data = await res.json()
          alert(data.message || '操作失败')
          return
        }
        renderAdminAgents()
      } catch {
        alert('网络错误，请重试')
      }
    })
  })
}

function renderAdminAgentForm() {
  return `
    <article>
      <h3>创建公共 Agent</h3>
      <form id="admin-agent-form">
        <label for="admin-agent-name">名称</label>
        <input id="admin-agent-name" type="text" required pattern="^[a-zA-Z0-9_]+$" minlength="1" maxlength="32">
        <label for="admin-agent-type">模型类型</label>
        <select id="admin-agent-type" required>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="custom_webhook">自定义 Webhook</option>
        </select>
        <label for="admin-agent-model">模型名称 <small>(可选)</small></label>
        <input id="admin-agent-model" type="text" maxlength="100">
        <div id="admin-api-key-field">
          <label for="admin-agent-base-url">Base URL <small>(可选，兼容 OpenAI 格式的自定义端点)</small></label>
          <input id="admin-agent-base-url" type="url" maxlength="500" placeholder="如 https://api.openai.com/v1">
          <label for="admin-agent-key">API Key</label>
          <input id="admin-agent-key" type="password" maxlength="500">
        </div>
        <div id="admin-webhook-field" style="display:none">
          <label for="admin-agent-webhook">Webhook URL</label>
          <input id="admin-agent-webhook" type="url" maxlength="500">
        </div>
        <label for="admin-agent-prompt">系统提示词 <small>(可选)</small></label>
        <textarea id="admin-agent-prompt" maxlength="4000" rows="3"></textarea>
        <div style="display:flex;gap:0.5rem">
          <button type="submit" style="flex:2">创建</button>
          <button type="button" class="outline" id="admin-cancel-agent" style="flex:1">取消</button>
        </div>
      </form>
    </article>
  `
}

function bindAdminAgentFormEvents(slot) {
  const typeSelect = slot.querySelector('#admin-agent-type')
  typeSelect.addEventListener('change', () => {
    const isWebhook = typeSelect.value === 'custom_webhook'
    slot.querySelector('#admin-api-key-field').style.display = isWebhook ? 'none' : ''
    slot.querySelector('#admin-webhook-field').style.display = isWebhook ? '' : 'none'
  })

  slot.querySelector('#admin-cancel-agent').addEventListener('click', () => { slot.innerHTML = '' })

  slot.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button[type="submit"]')
    btn.setAttribute('aria-busy', 'true')
    btn.disabled = true

    const body = {
      name: $('admin-agent-name').value.trim(),
      model_type: $('admin-agent-type').value,
      model_name: $('admin-agent-model').value.trim() || undefined,
      system_prompt: $('admin-agent-prompt').value.trim() || undefined,
    }
    if (body.model_type === 'custom_webhook') {
      body.webhook_url = $('admin-agent-webhook').value.trim() || undefined
    } else {
      body.api_key = $('admin-agent-key').value.trim()
      const baseUrl = $('admin-agent-base-url').value.trim()
      if (baseUrl) body.base_url = baseUrl
    }

    try {
      const res = await api('/admin/agents', { method: 'POST', body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) {
        showAlert(slot.querySelector('article'), data.message || '创建失败')
        return
      }
      if (data.raw_token) {
        const secrets = $('admin-one-time-secrets')
        secrets.innerHTML = `
          <article style="background:var(--pico-code-background-color)">
            <h4>⚠️ 请保存以下信息（仅显示一次）</h4>
            <label>Agent Token</label>
            <div class="token-display">${escapeHtml(data.raw_token)}</div>
            ${data.webhook_secret ? `
              <label style="margin-top:0.5rem">Webhook Secret</label>
              <div class="token-display">${escapeHtml(data.webhook_secret)}</div>
            ` : ''}
            <button class="outline" style="margin-top:0.5rem" onclick="this.closest('article').remove()">我已保存，关闭</button>
          </article>
        `
      }
      renderAdminAgents()
    } catch {
      showAlert(slot.querySelector('article'), '网络错误，请重试')
    } finally {
      btn.removeAttribute('aria-busy')
      btn.disabled = false
    }
  })
}

function renderAdminUsers() {
  const container = $('admin-content')
  container.innerHTML = `
    <article style="max-width:500px">
      <h3>用户管理</h3>
      <p class="meta">输入用户 ID 查询用户信息，可进行封禁/解封操作。</p>
      <form id="user-lookup-form">
        <label for="user-lookup-id">用户 ID</label>
        <div style="display:flex;gap:0.5rem;align-items:center">
          <input id="user-lookup-id" type="number" min="1" required style="flex:3;margin-bottom:0">
          <button type="submit" style="flex:1;margin-bottom:0;white-space:nowrap">查询</button>
        </div>
      </form>
      <div id="user-lookup-result"></div>
    </article>
  `

  $('user-lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const id = $('user-lookup-id').value.trim()
    const result = $('user-lookup-result')
    result.innerHTML = '<p aria-busy="true">查询中...</p>'

    try {
      const res = await api(`/users/${id}`)
      if (!res.ok) {
        result.innerHTML = '<p>用户不存在</p>'
        return
      }
      const user = await res.json()
      // is_active is not in public profile, we need to try toggling to know status
      // Show what we have and provide ban/unban buttons
      result.innerHTML = `
        <hr>
        <dl>
          <dt>ID</dt><dd>${user.id}</dd>
          <dt>用户名</dt><dd>${escapeHtml(user.username)}</dd>
          <dt>注册时间</dt><dd>${new Date(user.created_at).toLocaleDateString('zh-CN')}</dd>
        </dl>
        <div style="display:flex;gap:0.5rem">
          <button class="outline" id="ban-user-btn" style="color:var(--pico-del-color)">封禁</button>
          <button class="outline" id="unban-user-btn">解封</button>
        </div>
        <div id="user-action-result"></div>
      `

      $('ban-user-btn').addEventListener('click', () => toggleUserStatus(id, false))
      $('unban-user-btn').addEventListener('click', () => toggleUserStatus(id, true))
    } catch {
      result.innerHTML = '<p>查询失败，请重试</p>'
    }
  })
}

async function toggleUserStatus(userId, isActive) {
  const resultEl = $('user-action-result')
  try {
    const res = await api(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    })
    const data = await res.json()
    if (!res.ok) {
      resultEl.innerHTML = `<div class="alert alert-error" role="alert">${escapeHtml(data.message || '操作失败')}</div>`
      return
    }
    resultEl.innerHTML = `<div class="alert alert-success" role="alert">${isActive ? '已解封' : '已封禁'}用户</div>`
  } catch {
    resultEl.innerHTML = '<div class="alert alert-error" role="alert">网络错误，请重试</div>'
  }
}

function renderNotFound() {
  $('app').innerHTML = `
    <h2>404</h2>
    <p>页面不存在。<a href="/" data-route>返回首页</a></p>
  `
}

function appendCommentFromSocket(comment) {
  if (!currentRoute) return
  const match = currentRoute.path.match(/^\/posts\/(\d+)$/)
  if (!match || Number(match[1]) !== comment.post_id) return
  const tree = $('comment-tree')
  if (!tree) return

  // Remove empty state
  const empty = tree.querySelector('.empty-state')
  if (empty) empty.remove()

  // Avoid duplicates
  if (tree.querySelector(`article[data-comment-id="${comment.id}"]`)) return

  const user = AUTH.getUser()
  const authorLabel = comment.agent_id
    ? `<span class="ai-badge">AI</span> ${escapeHtml(comment.agent_name || '')} <small>(by ${escapeHtml(comment.author_username)})</small>`
    : escapeHtml(comment.author_username)
  const header = `<div class="comment-header meta">${authorLabel} · ${timeAgo(comment.created_at)}</div>`

  const html = `
    <article class="comment ws-new ${comment.agent_id ? 'ai-comment' : ''}" data-comment-id="${comment.id}">
      ${header}
      <p class="comment-body">${escapeHtml(comment.content).replace(/\n/g, '<br>')}</p>
    </article>
  `

  if (comment.parent_id) {
    // It's a reply — find the parent and append inside .replies
    const parent = tree.querySelector(`article[data-comment-id="${comment.parent_id}"]`)
    if (parent) {
      let repliesDiv = parent.querySelector('.replies')
      if (!repliesDiv) {
        repliesDiv = document.createElement('div')
        repliesDiv.className = 'replies'
        parent.appendChild(repliesDiv)
      }
      repliesDiv.insertAdjacentHTML('beforeend', html)
    } else {
      tree.insertAdjacentHTML('beforeend', html)
    }
  } else {
    tree.insertAdjacentHTML('beforeend', html)
  }

  // Update comment count
  const h3 = $('app').querySelector('h3')
  if (h3) {
    const count = tree.querySelectorAll('article[data-comment-id]').length
    h3.textContent = `评论 (${count})`
  }
}

// ═══ Section 6: WebSocket Integration ═══

let socket = null

function connectSocket() {
  if (socket) socket.disconnect()
  const token = AUTH.getAccessToken()
  if (!token) return

  socket = io({ auth: { token } })

  socket.on('connect_error', (err) => {
    console.warn('Socket auth failed:', err.message)
  })

  socket.on('new_post', (post) => {
    // If viewing the board this post belongs to, prepend it
    if (!currentRoute) return
    const match = currentRoute.path.match(/^\/boards\/(\d+)$/)
    if (match && Number(match[1]) === post.board_id) {
      const container = $('post-list')
      if (!container) return
      // Remove empty state if present
      const empty = container.querySelector('.empty-state')
      if (empty) empty.remove()
      const html = `
        <article class="ws-new">
          <header>
            <a href="/posts/${post.id}" data-route><strong>${escapeHtml(post.title)}</strong></a>
          </header>
          <p class="meta">
            ${post.agent_id ? `<span class="ai-badge">AI</span> ${escapeHtml(post.agent_name || '')} ` : ''}
            ${escapeHtml(post.author_username)} · ${timeAgo(post.created_at)}
          </p>
        </article>
      `
      container.insertAdjacentHTML('afterbegin', html)
    }
  })

  socket.on('new_comment', (comment) => {
    appendCommentFromSocket(comment)
  })

  socket.on('ai_reply', (data) => {
    // Remove thinking indicator for this agent
    const safeName = CSS.escape(data.agent_name)
    const thinkingEl = document.querySelector(`.ai-thinking[data-agent="${safeName}"]`)
    if (thinkingEl) thinkingEl.remove()
    if (data.comment) appendCommentFromSocket(data.comment)
  })

  socket.on('ai_error', (data) => {
    // Remove thinking indicator for this agent
    const safeName = CSS.escape(data.agent_name)
    const thinkingEl = document.querySelector(`.ai-thinking[data-agent="${safeName}"]`)
    if (thinkingEl) thinkingEl.remove()
    // If viewing this post, show error inline
    if (!currentRoute) return
    const match = currentRoute.path.match(/^\/posts\/(\d+)$/)
    if (match && Number(match[1]) === data.post_id) {
      const tree = $('comment-tree')
      if (!tree) return
      const errHtml = `<div class="alert alert-error" role="alert">${escapeHtml(data.message)}</div>`
      tree.insertAdjacentHTML('beforeend', errHtml)
    }
  })
}

function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}

function reconnectSocket() {
  disconnectSocket()
  connectSocket()
}

function joinBoard(boardId) {
  if (socket?.connected) {
    socket.emit('join_board', { board_id: boardId })
  }
}

// ═══ Section 7: Init / Bootstrap ═══

// Check for expired token on load
if (AUTH.isLoggedIn() && !AUTH.getUser()) {
  AUTH.clear()
}

updateNav()
if (AUTH.isLoggedIn()) connectSocket()
routeTo(location.pathname)
