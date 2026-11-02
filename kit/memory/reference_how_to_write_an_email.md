---
name: How to write or reply to an email
description: Email, write an email, reply to this email, follow up by mail, draft a mail for me: how to write or reply to an email in the owner's saved format, check the draft, and send only after an explicit yes. Read before drafting or replying to any email.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: bc51e747b109f55d
---

# How to write or reply to an email

An email is read later, searched, quoted and forwarded, so it must make sense on its own. A first message to someone new also follows [[reference_how_to_write_a_first_message_to_someone_new]]; a long or formal one is a document ([[reference_how_to_write_a_document]]).

## What good looks like

- It follows the owner's saved format: greeting, structure, length, sign-off, signature and language.
- The purpose is in the first sentence or two: one purpose, at most one ask.
- Two or three short paragraphs of plain facts, an empty line between them. A plain table only for numbers; a chart or highlight only when it makes the email easier to read.

## Steps, in order

1. **Recall the owner's format** for this kind of reader. If none is saved, ask the owner once and save the answer ([[reference_how_to_save_a_memory]]). If earlier emails from the owner to this person exist, read two or three and match that tone: too direct and too friendly are both wrong.
2. **Settle the purpose:** one thing the email must achieve; the rest waits for the answer. If the owner already wrote to this person on this topic, say when and recap in one line.
3. **Write the subject** (nine words or fewer) **and the body:** one sentence of context, then the facts. Ask only what is needed, in a sentence of its own, never a list; an email that only informs ends after its facts. Use only facts the owner gave or memory records, and mark any gap instead of guessing. Write in the reader's language unless the owner's format says otherwise, with its accents. Writing up to a senior person, give context before the ask.
4. **On a reply,** keep the thread's subject, answer the latest message, put the new text above the quoted history, and keep everyone in To and Cc except the owner, unless told otherwise.
5. **Check the draft.** Save it as plain text with a "Subject:" line and run `node tools/email-check.mjs draft.txt` (add `--first` for a first contact). It fails: over 125 words on a first contact (200 otherwise), more than two questions on a first contact, any list line, a sentence over 30 words, common AI phrases, a long subject, signs of price shopping, French without accents. Fix each failure, then read the draft as the recipient. The checker tests form only: a draft can pass and still miss the owner's format.
6. **Read it back as it will arrive:** recipients, subject, body, signature, attachments. A reply can carry images from the original's signature as attachments nobody chose. View formatting rendered: mail programs often drop paragraph spacing.
7. **Show the draft and send only on an explicit yes** ([[feedback_reversible_act_irreversible_ask]]). If the owner cuts or rewrites it, save what changed and why, so the next draft starts closer.

## Mistakes to avoid, and what to do instead

| Instead of | Do this |
|---|---|
| "I hope this finds you well", "I am writing to" | Open with the purpose, or one line of thanks for what they last did |
| Several asks, or a question added to fill the ending | One ask; the rest waits for the answer |
| Opinions about third parties, or the owner's reasoning | Facts only; let the reader conclude |
| Telling a supplier the owner compares offers or knows the public price | Write as a committed partner: volumes, terms, a plain request for the best terms |
| A status email that blames someone or announces a workaround nobody asked for | State the problem and what still works, then stop |

## Why

A 2016 study of 40 million emails found that replies peaked at about 75 to 100 words and that one to three questions beat none. Talk of comparing marks the sender as a price shopper, so the supplier has no reason to offer partner terms.

## Related
[[reference_how_to_write_a_first_message_to_someone_new]] [[reference_how_to_write_chat_messages]] [[reference_how_to_write_a_document]] [[reference_how_to_save_a_memory]] [[feedback_reversible_act_irreversible_ask]]
