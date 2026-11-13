ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_bookable BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS allows_overlap BOOLEAN NOT NULL DEFAULT FALSE AFTER is_bookable;
ALTER TABLE calendar_events MODIFY COLUMN source ENUM('website','microsoft365','municipality') NOT NULL;

INSERT INTO resources (id,slug,name,location,capacity,is_active,is_bookable,allows_overlap) VALUES
  ('c75a1b0e-9ea5-4c15-b0dd-1a249c105004','evenementenkalender','Evenementenkalender','Sint Jut',NULL,TRUE,FALSE,TRUE)
ON DUPLICATE KEY UPDATE name=VALUES(name),location=VALUES(location),is_active=TRUE,is_bookable=FALSE,allows_overlap=TRUE;

CREATE TABLE IF NOT EXISTS event_requests (
  id CHAR(36) PRIMARY KEY,
  reference VARCHAR(32) NOT NULL UNIQUE,
  title VARCHAR(180) NOT NULL,
  public_description TEXT NULL,
  location VARCHAR(255) NOT NULL,
  organizer_name VARCHAR(160) NOT NULL,
  organizer_email VARCHAR(254) NOT NULL,
  organizer_phone VARCHAR(40) NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME(3) NULL,
  calendar_event_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_event_request_reviewer FOREIGN KEY (reviewed_by) REFERENCES admin_users(id),
  CONSTRAINT fk_event_request_event FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id),
  INDEX idx_event_request_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
