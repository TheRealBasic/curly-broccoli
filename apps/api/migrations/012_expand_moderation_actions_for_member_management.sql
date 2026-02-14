ALTER TABLE moderation_audit_logs
  DROP CONSTRAINT IF EXISTS moderation_audit_logs_action_check;

ALTER TABLE moderation_audit_logs
  ADD CONSTRAINT moderation_audit_logs_action_check
  CHECK (
    action IN (
      'message_delete',
      'message_report',
      'user_mute',
      'user_unmute',
      'member_permission_update',
      'screen_share_start',
      'screen_share_stop',
      'screen_share_force_stop',
      'message_edit'
    )
  );
