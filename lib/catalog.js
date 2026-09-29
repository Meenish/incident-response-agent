import { LAB_FIXES } from './lab.js';

export const FIXES = { ...LAB_FIXES };

// A deliberately small generic playbook: all choices execute against the lab.
export function genericPlaybook(alert) {
  const text = `${alert.title} ${(alert.logs || []).join(' ')}`.toLowerCase();
  const order = ['restart-service'];
  if (/redis|maxclients/.test(text)) order.push('increase-redis-pool');
  if (/postgres|connection slots|too many clients/.test(text)) order.push('kill-long-queries');
  return order;
}
