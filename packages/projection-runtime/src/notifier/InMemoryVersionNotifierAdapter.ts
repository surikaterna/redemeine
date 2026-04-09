import type {
  ProjectionVersionAvailableNotification,
  VersionNotifierContract
} from '../contracts/versionNotifier';

function cloneNotification(
  notification: ProjectionVersionAvailableNotification
): ProjectionVersionAvailableNotification {
  return {
    projectionName: notification.projectionName,
    documentId: notification.documentId,
    version: notification.version
  };
}

export function projectionVersionNotificationKey(notification: ProjectionVersionAvailableNotification): string {
  return `${notification.projectionName}:${notification.documentId}:${notification.version}`;
}

export class InMemoryVersionNotifierAdapter implements VersionNotifierContract {
  private readonly notifications: ProjectionVersionAvailableNotification[] = [];

  async notifyVersionAvailable(notification: ProjectionVersionAvailableNotification): Promise<void> {
    this.notifications.push(cloneNotification(notification));
  }

  getNotifications(): ProjectionVersionAvailableNotification[] {
    return this.notifications.map(cloneNotification);
  }

  clear(): void {
    this.notifications.length = 0;
  }
}
