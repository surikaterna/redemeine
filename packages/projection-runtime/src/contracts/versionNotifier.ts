export interface ProjectionVersionAvailableNotification {
  projectionName: string;
  documentId: string;
  version: number;
}

export interface VersionNotifierContract {
  notifyVersionAvailable(notification: ProjectionVersionAvailableNotification): Promise<void>;
}
