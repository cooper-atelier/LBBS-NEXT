export function ownerOrAdmin(request, reply, resourceOwnerId) {
  if (request.user.id !== resourceOwnerId && request.user.role !== 'admin') {
    reply.code(403).send({ error: 'FORBIDDEN', message: '只有资源所有者或管理员可以执行此操作' })
    return false
  }
  return true
}
