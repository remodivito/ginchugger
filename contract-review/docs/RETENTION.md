# Retention statement (template)

A template for the team to adopt (product v2 spec PR-SEC-08, decision 160; the store model of decisions 190 and 191). Fill in the brackets, agree it, then press "Mark retention statement adopted" on the Admin page, which records the date in the settings file. The app enforces only what section 4 describes: there are no retention schedules or disposition reviews in this version.

---

**[Team name]: retention of the contract documents**

1. **What is kept.** GinChugger keeps the contracts, markups and covering emails we add to its document store, their extracted text, their labels (counterparty, type, tags, date), notes (including a note for each point where we accepted the other side's wording), the store's history of who changed what, and a review history of what was done with each document (findings flagged, dismissed or applied) and of playbook changes. Counterparty documents and emails can contain personal data, such as names, job titles and email addresses.
2. **Why.** To review each new draft against our playbook and against what we agreed before with the same counterparty.
3. **How long.** The store is reviewed once a year by [role]. A document is moved to the trash on request, or when the agreement's end date has passed by [N] years. [N] is set with the Limitation Act 1980 in mind (six years for a simple contract, twelve for a deed).
4. **How it is deleted.** "Move to trash" on the document's page, by anyone on the team; a document tagged "signed", or one an admin has put on hold, cannot be moved to the trash, and only an admin sets or lifts a hold. Anything in the trash can be restored from the Trash page. Nothing is deleted for good unless `trash.purgeAfterDays` is set in the settings file, in which case the store empties, daily, items that have been in the trash for more than that many days ([N days], or "not set"). The store's history records who moved a document to the trash and when.
5. **Backups.** Backups hold deleted documents until they are themselves replaced. Backups are kept for [period].
6. **Requests.** A request to delete personal data goes to [contact], who moves the documents to the trash or explains why they are kept.

Adopted on [date] by [name].
