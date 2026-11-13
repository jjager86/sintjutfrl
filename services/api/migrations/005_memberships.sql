ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_manage_memberships BOOLEAN NOT NULL DEFAULT FALSE AFTER is_super_admin;

CREATE TABLE IF NOT EXISTS membership_requests (
  id CHAR(36) PRIMARY KEY,
  reference VARCHAR(32) NOT NULL UNIQUE,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(160) NOT NULL,
  street VARCHAR(180) NOT NULL,
  house_number VARCHAR(30) NOT NULL,
  email VARCHAR(254) NOT NULL,
  associations JSON NOT NULL,
  iban_encrypted TEXT NOT NULL,
  iban_last4 CHAR(4) NOT NULL,
  account_name VARCHAR(180) NOT NULL,
  note TEXT NULL,
  sepa_accepted_at DATETIME(3) NOT NULL,
  status ENUM('pending','processed','rejected') NOT NULL DEFAULT 'pending',
  handled_by CHAR(36) NULL,
  handled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_membership_handler FOREIGN KEY (handled_by) REFERENCES admin_users(id),
  INDEX idx_membership_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
