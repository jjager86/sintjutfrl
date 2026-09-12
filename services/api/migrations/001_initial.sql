CREATE TABLE IF NOT EXISTS resources (
  id CHAR(36) PRIMARY KEY,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  location VARCHAR(255) NULL,
  capacity INT UNSIGNED NULL,
  graph_calendar_id VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reservations (
  id CHAR(36) PRIMARY KEY,
  reference VARCHAR(32) NOT NULL UNIQUE,
  resource_id CHAR(36) NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NULL,
  public_description TEXT NULL,
  organizer_name VARCHAR(160) NOT NULL,
  organizer_email VARCHAR(254) NOT NULL,
  organizer_phone VARCHAR(40) NULL,
  attendee_count INT UNSIGNED NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  status ENUM('pending','approved_pending_sync','confirmed','rejected','cancelled','sync_error') NOT NULL DEFAULT 'pending',
  graph_event_id VARCHAR(255) NULL,
  graph_transaction_id VARCHAR(255) NULL,
  telegram_chat_id VARCHAR(64) NULL,
  telegram_message_id BIGINT NULL,
  approved_by_telegram_user_id VARCHAR(64) NULL,
  approved_by_name VARCHAR(160) NULL,
  approved_at DATETIME(3) NULL,
  rejected_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_reservation_resource FOREIGN KEY (resource_id) REFERENCES resources(id),
  INDEX idx_reservation_resource_time (resource_id, starts_at, ends_at),
  INDEX idx_reservation_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar_events (
  id CHAR(36) PRIMARY KEY,
  resource_id CHAR(36) NOT NULL,
  reservation_id CHAR(36) NULL,
  source ENUM('website','microsoft365') NOT NULL,
  external_id VARCHAR(255) NULL,
  title VARCHAR(180) NOT NULL,
  public_description TEXT NULL,
  location VARCHAR(255) NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_event_resource FOREIGN KEY (resource_id) REFERENCES resources(id),
  CONSTRAINT fk_event_reservation FOREIGN KEY (reservation_id) REFERENCES reservations(id),
  UNIQUE KEY uq_event_external (resource_id, external_id),
  UNIQUE KEY uq_event_reservation (reservation_id),
  INDEX idx_event_public_range (starts_at, ends_at, is_cancelled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_tokens (
  id CHAR(36) PRIMARY KEY,
  reservation_id CHAR(36) NOT NULL,
  action ENUM('approve','reject') NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_token_reservation FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE,
  INDEX idx_token_reservation (reservation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  topic VARCHAR(80) NOT NULL,
  aggregate_id CHAR(36) NULL,
  payload JSON NOT NULL,
  status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at DATETIME(3) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  INDEX idx_outbox_poll (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reservation_id CHAR(36) NULL,
  actor_type ENUM('visitor','telegram','system','microsoft365') NOT NULL,
  actor_id VARCHAR(160) NULL,
  action VARCHAR(80) NOT NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_reservation (reservation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO resources (id, slug, name, location, capacity) VALUES
  ('c75a1b0e-9ea5-4c15-b0dd-1a249c105001', 'doarpsfinne', 'Doarpsfinne', 'Rotsterhaule', NULL),
  ('c75a1b0e-9ea5-4c15-b0dd-1a249c105002', 'vergaderruimte', 'Vergaderruimte', 'Rotsterhaule', 20),
  ('c75a1b0e-9ea5-4c15-b0dd-1a249c105003', 'grote-zaal', 'Grote zaal', 'Rotsterhaule', 150)
ON DUPLICATE KEY UPDATE name = VALUES(name), location = VALUES(location), capacity = VALUES(capacity);
