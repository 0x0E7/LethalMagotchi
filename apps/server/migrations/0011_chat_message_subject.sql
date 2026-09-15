-- Who a system row is *about*. A system message has no author, and `author_account_id IS
-- DISTINCT FROM $viewer` therefore counts "X joined the group." towards X's own unread
-- badge: NULL is distinct from every account id, including theirs. Naming the subject lets
-- the unread projections exclude the one person who already knows.
ALTER TABLE chat_messages
  ADD COLUMN subject_account_id uuid REFERENCES accounts (id) ON DELETE SET NULL;

-- Only an authorless row has a subject: a player's own message is already excluded from
-- their own unread count by its authorship, and nothing may write a message "about" someone
-- while also claiming an author.
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_subject_is_system
  CHECK (subject_account_id IS NULL OR author_account_id IS NULL);
