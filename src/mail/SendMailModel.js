// @flow
import {Dialog} from "../gui/base/Dialog"
import type {Language} from "../misc/LanguageViewModel"
import {_getSubstitutedLanguageCode, getAvailableLanguageCode, lang, languages} from "../misc/LanguageViewModel"
import type {ConversationTypeEnum} from "../api/common/TutanotaConstants"
import {ConversationType, MAX_ATTACHMENT_SIZE, OperationType, ReplyType} from "../api/common/TutanotaConstants"
import {load, setup, update} from "../api/main/Entity"
import {worker} from "../api/main/WorkerClient"
import type {RecipientInfo} from "../api/common/RecipientInfo"
import {isExternal} from "../api/common/RecipientInfo"
import {LockedError, NotAuthorizedError, NotFoundError, PreconditionFailedError, TooManyRequestsError} from "../api/common/error/RestError"
import {UserError} from "../api/common/error/UserError"
import {assertMainOrNode} from "../api/Env"
import {getPasswordStrength} from "../misc/PasswordUtils"
import {assertNotNull, downcast, neverNull} from "../api/common/utils/Utils"
import {
	createRecipientInfo,
	getDefaultSender,
	getEmailSignature,
	getEnabledMailAddressesWithUser,
	getMailboxName,
	getSenderNameForUser,
	parseMailtoUrl,
	resolveRecipientInfo
} from "./MailUtils"
import type {File as TutanotaFile} from "../api/entities/tutanota/File"
import {FileTypeRef} from "../api/entities/tutanota/File"
import {ConversationEntryTypeRef} from "../api/entities/tutanota/ConversationEntry"
import type {Mail} from "../api/entities/tutanota/Mail"
import {MailTypeRef} from "../api/entities/tutanota/Mail"
import type {Contact} from "../api/entities/tutanota/Contact"
import {ContactTypeRef} from "../api/entities/tutanota/Contact"
import {isSameId, stringToCustomId} from "../api/common/EntityFunctions"
import {FileNotFoundError} from "../api/common/error/FileNotFoundError"
import {logins} from "../api/main/LoginController"
import type {MailAddress} from "../api/entities/tutanota/MailAddress"
import type {MailboxDetail} from "./MailModel"
import {locator} from "../api/main/MainLocator"
import {LazyContactListId} from "../contacts/ContactUtils"
import {RecipientNotResolvedError} from "../api/common/error/RecipientNotResolvedError"
import stream from "mithril/stream/stream.js"
import type {EntityEventsListener} from "../api/main/EventController"
import {isUpdateForTypeRef} from "../api/main/EventController"
import {CustomerPropertiesTypeRef} from "../api/entities/sys/CustomerProperties"
import type {InlineImages} from "./MailViewer"
import {isMailAddress} from "../misc/FormatValidator"
import {createApprovalMail} from "../api/entities/monitor/ApprovalMail"
import type {EncryptedMailAddress} from "../api/entities/tutanota/EncryptedMailAddress"
import {remove} from "../api/common/utils/ArrayUtils"

assertMainOrNode()

export type Recipient = {name: ?string, address: string, contact?: ?Contact}
export type RecipientList = $ReadOnlyArray<Recipient>
export type Recipients = {to?: RecipientList, cc?: RecipientList, bcc?: RecipientList}

// Because MailAddress does not have contact of the right type (event when renamed on Recipient) MailAddress <: Recipient does not hold
function toRecipient({address, name}: MailAddress): Recipient {
	return {name, address}
}

type EditorAttachment = TutanotaFile | DataFile | FileReference
type RecipientField = "to" | "cc" | "bcc"

export class SendMailModel {
	draft: ?Mail;
	recipientsChanged: Stream<void>;
	_senderAddress: string;
	_selectedNotificationLanguage: string;
	_toRecipients: Array<RecipientInfo>;
	_ccRecipients: Array<RecipientInfo>;
	_bccRecipients: Array<RecipientInfo>;
	_replyTos: Array<RecipientInfo>;
	_subject: Stream<string>;
	_body: string; // only defined till the editor is initialized
	_conversationType: ConversationTypeEnum;
	_previousMessageId: ?Id; // only needs to be the correct value if this is a new email. if we are editing a draft, conversationType is not used
	// TODO
	_confidentialButtonState: boolean;

	_attachments: Array<EditorAttachment>; // contains either Files from Tutanota or DataFiles of locally loaded files. these map 1:1 to the _attachmentButtons
	_mailChanged: boolean;
	_previousMail: ?Mail;
	_entityEventReceived: EntityEventsListener;
	_mailboxDetails: MailboxDetail;

	_objectURLs: Array<string>;
	_blockExternalContent: boolean;
	_mentionedInlineImages: Array<string>
	// TODO
	/** HTML elements which correspond to inline images. We need them to check that they are removed/remove them later */
	_inlineImageElements: Array<HTMLElement>

	/**
	 * Creates a new draft message. Invoke initAsResponse or initFromDraft if this message should be a response
	 * to an existing message or edit an existing draft.
	 *
	 */
	constructor(mailboxDetails: MailboxDetail) {
		this._conversationType = ConversationType.NEW
		this._toRecipients = []
		this._ccRecipients = []
		this._bccRecipients = []
		this._replyTos = []
		this._attachments = []
		this._mailChanged = false
		this._previousMail = null
		this.draft = null
		this._mailboxDetails = mailboxDetails
		this._objectURLs = []
		this._blockExternalContent = true
		this._mentionedInlineImages = []
		this._inlineImageElements = []
		// TODO: update this stream when something changes
		this.recipientsChanged = stream(undefined)

		let props = logins.getUserController().props

		this._senderAddress = getDefaultSender(this._mailboxDetails)

		let sortedLanguages = languages.slice().sort((a, b) => lang.get(a.textId).localeCompare(lang.get(b.textId)))
		this._selectedNotificationLanguage = getAvailableLanguageCode(props.notificationMailLanguage || lang.code)

		getTemplateLanguages(sortedLanguages)
			.then((filteredLanguages) => {
				if (filteredLanguages.length > 0) {
					const languageCodes = filteredLanguages.map(l => l.code)
					this._selectedNotificationLanguage = _getSubstitutedLanguageCode(props.notificationMailLanguage
						|| lang.code, languageCodes) || languageCodes[0]
					sortedLanguages = filteredLanguages
				}
			})

		this._confidentialButtonState = !props.defaultUnconfidential
		this._subject = stream("")

		// TODO
		this._subject.map(() => this._mailChanged = true)

		this._entityEventReceived = (updates) => {
			for (let update of updates) {
				this._handleEntityEvent(update)
			}
		}
		this._mailChanged = false
	}

	setSubject(subject: string) {
		this._subject(subject)
	}

	selectSender(senderAddress: string) {
		// TODO: checks
		this._senderAddress = senderAddress
	}

	getPasswordStrength(recipientInfo: RecipientInfo) {
		const contact = assertNotNull(recipientInfo.contact)
		let reserved = getEnabledMailAddressesWithUser(this._mailboxDetails, logins.getUserController().userGroupInfo).concat(
			getMailboxName(this._mailboxDetails),
			recipientInfo.mailAddress,
			recipientInfo.name
		)
		return Math.min(100, getPasswordStrength(contact.presharedPassword || "", reserved) / 0.8)
	}

	initAsResponse({
		               previousMail, conversationType, senderMailAddress, recipients, attachments, subject, bodyText, replyTos,
		               addSignature, inlineImages, blockExternalContent
	               }: {
		previousMail: Mail,
		conversationType: ConversationTypeEnum,
		senderMailAddress: string,
		recipients: Recipients,
		attachments: TutanotaFile[],
		subject: string,
		bodyText: string,
		replyTos: EncryptedMailAddress[],
		addSignature: boolean,
		inlineImages?: ?Promise<InlineImages>,
		blockExternalContent: boolean
	}): Promise<void> {
		this._blockExternalContent = blockExternalContent
		if (addSignature) {
			bodyText = "<br/><br/><br/>" + bodyText
			let signature = getEmailSignature()
			if (logins.getUserController().isInternalUser() && signature) {
				bodyText = signature + bodyText
			}
		}
		let previousMessageId: ?string = null
		return load(ConversationEntryTypeRef, previousMail.conversationEntry)
			.then(ce => {
				previousMessageId = ce.messageId
			})
			.catch(NotFoundError, e => {
				console.log("could not load conversation entry", e);
			})
			.then(() => {
				return this._setMailData(previousMail, previousMail.confidential, conversationType, previousMessageId, senderMailAddress,
					recipients, attachments, subject, bodyText, replyTos)
			})
	}

	initWithTemplate(recipients: Recipients, subject: string, bodyText: string, confidential: ?boolean, senderMailAddress?: string): Promise<void> {
		const sender = senderMailAddress ? senderMailAddress : this._senderAddress

		this._setMailData(null, confidential, ConversationType.NEW, null, sender, recipients, [], subject, bodyText, [])
		return Promise.resolve()
	}

	initWithMailtoUrl(mailtoUrl: string, confidential: boolean): Promise<void> {
		const result = parseMailtoUrl(mailtoUrl)

		let bodyText = result.body
		const signature = getEmailSignature()
		if (logins.getUserController().isInternalUser() && signature) {
			bodyText = bodyText + signature
		}
		const {to, cc, bcc} = result
		this._setMailData(null, confidential, ConversationType.NEW, null, this._senderAddress, {to, cc, bcc}, [], result.subject, bodyText,
			[])
		return Promise.resolve()
	}

	initFromDraft({draftMail, attachments, bodyText, inlineImages, blockExternalContent}: {
		draftMail: Mail,
		attachments: TutanotaFile[],
		bodyText: string,
		blockExternalContent: boolean,
		inlineImages?: Promise<InlineImages>
	}): Promise<void> {
		let conversationType: ConversationTypeEnum = ConversationType.NEW
		let previousMessageId: ?string = null
		let previousMail: ?Mail = null
		this.draft = draftMail
		this._blockExternalContent = blockExternalContent

		return load(ConversationEntryTypeRef, draftMail.conversationEntry).then(ce => {
			conversationType = downcast(ce.conversationType)
			if (ce.previous) {
				return load(ConversationEntryTypeRef, ce.previous).then(previousCe => {
					previousMessageId = previousCe.messageId
					if (previousCe.mail) {
						return load(MailTypeRef, previousCe.mail).then(mail => {
							previousMail = mail
						})
					}
				}).catch(NotFoundError, e => {
					// ignore
				})
			}
		}).then(() => {
			const {confidential, sender, toRecipients, ccRecipients, bccRecipients, subject, replyTos} = draftMail
			const recipients: Recipients = {
				to: toRecipients.map(toRecipient),
				cc: ccRecipients.map(toRecipient),
				bcc: bccRecipients.map(toRecipient),
			}
			// We don't want to wait for the editor to be initialized, otherwise it will never be shown
			return this._setMailData(previousMail, confidential, conversationType, previousMessageId, sender.address, recipients, attachments,
				subject, bodyText, replyTos)
		})
	}

	_setMailData(previousMail: ?Mail, confidential: ?boolean, conversationType: ConversationTypeEnum, previousMessageId: ?string,
	             senderMailAddress: string, recipients: Recipients, attachments: TutanotaFile[], subject: string,
	             body: string, replyTos: EncryptedMailAddress[]): Promise<void> {
		this._previousMail = previousMail
		this._conversationType = conversationType
		this._previousMessageId = previousMessageId
		if (confidential != null) {
			this._confidentialButtonState = confidential
		}
		this._senderAddress = senderMailAddress
		this._subject(subject)
		this._attachments = []

		this.attachFiles(((attachments: any): Array<TutanotaFile | DataFile | FileReference>))

		const {to = [], cc = [], bcc = []} = recipients
		// TODO
		this._toRecipients = to.filter(r => isMailAddress(r.address, false))
		                       .map((r) => createRecipientInfo(r.address, r.name, r.contact))
		this._ccRecipients = cc.filter(r => isMailAddress(r.address, false))
		                       .map((r) => createRecipientInfo(r.address, r.name, r.contact))
		this._bccRecipients = bcc.filter(r => isMailAddress(r.address, false))
		                         .map((r) => createRecipientInfo(r.address, r.name, r.contact))
		this._replyTos = replyTos.map(ema => createRecipientInfo(ema.address, ema.name, null, true))
		this._mailChanged = false
		return Promise.resolve()
	}

	addRecipient(type: RecipientField, recipient: Recipient): RecipientInfo {
		const recipientInfo = createRecipientInfo(recipient.address, recipient.name, recipient.contact)
		this._recipientList(type).push(recipientInfo)
		resolveRecipientInfo(recipientInfo).then(() => this.recipientsChanged(undefined))
		recipientInfo.resolveContactPromise && recipientInfo.resolveContactPromise.then(() => this.recipientsChanged(undefined))
		this._mailChanged = true
		this.recipientsChanged(undefined)
		return recipientInfo
	}

	removeRecipient(type: RecipientField, recipient: RecipientInfo) {
		remove(this._recipientList(type), recipient)
		this.recipientsChanged(undefined)
	}

	setPassword(recipient: RecipientInfo, password: string) {
		if (recipient.contact) {
			recipient.contact.presharedPassword = password
		}
		this.recipientsChanged(undefined)
		return recipient
	}

	_recipientList(type: RecipientField): Array<RecipientInfo> {
		if (type === "to") {
			return this._toRecipients
		} else if (type === "cc") {
			return this._ccRecipients
		} else if (type === "bcc") {
			return this._bccRecipients
		}
		throw new Error()
	}

	// TODO
	show() {
		locator.eventController.addEntityListener(this._entityEventReceived)
	}


	_close() {
		locator.eventController.removeEntityListener(this._entityEventReceived)
	}

	/** @returns files which were too big to add */
	attachFiles(files: Array<EditorAttachment>): Array<EditorAttachment> {
		let totalSize = 0
		this._attachments.forEach(file => {
			totalSize += Number(file.size)
		})
		let tooBigFiles = [];
		files.forEach(file => {
			if (totalSize + Number(file.size) > MAX_ATTACHMENT_SIZE) {
				tooBigFiles.push(file)
			} else {
				totalSize += Number(file.size)
				this._attachments.push(file)
			}
		})
		this._mailChanged = true
		return tooBigFiles
	}

	/**
	 * Saves the draft.
	 * @param saveAttachments True if also the attachments shall be saved, false otherwise.
	 * @returns {Promise} When finished.
	 * @throws FileNotFoundError when one of the attachments could not be opened
	 * @throws PreconditionFailedError when the draft is locked
	 */
	saveDraft(body: string, saveAttachments: boolean): Promise<void> {
		const attachments = (saveAttachments) ? this._attachments : null
		const {draft} = this
		return Promise.resolve(draft == null
			? this._createDraft(body, attachments)
			: this._updateDraft(body, attachments, draft)
		).then((draft) => {
			this.draft = draft
			return Promise.map(draft.attachments, fileId => load(FileTypeRef, fileId)).then(attachments => {
				this._attachments = [] // attachFiles will push to existing files but we want to overwrite them
				this.attachFiles(attachments)
				this._mailChanged = false
			})
		})
	}

	_getSenderName() {
		return getSenderNameForUser(this._mailboxDetails, logins.getUserController())
	}

	_updateDraft(body: string, attachments: ?$ReadOnlyArray<EditorAttachment>, draft: Mail) {
		return worker
			.updateMailDraft(this._subject(), body, this._senderAddress, this._getSenderName(), this._toRecipients,
				this._ccRecipients, this._bccRecipients, attachments, this._isConfidential(), draft)
			.catch(LockedError, () => Dialog.error("operationStillActive_msg"))
			.catch(NotFoundError, () => {
				console.log("draft has been deleted, creating new one")
				return this._createDraft(body, attachments)
			})
	}

	_createDraft(body: string, attachments: ?$ReadOnlyArray<EditorAttachment>) {
		return worker.createMailDraft(this._subject(), body,
			this._senderAddress, this._getSenderName(), this._toRecipients, this._ccRecipients, this._bccRecipients, this._conversationType,
			this._previousMessageId, attachments, this._isConfidential(), this._replyTos)
	}

	_isConfidential() {
		return this._confidentialButtonState || !this._containsExternalRecipients()
	}

	_containsExternalRecipients() {
		return (this._allRecipients().find(r => isExternal(r)) != null)
	}

	/**
	 * @reject {RecipientNotResolvedError}
	 * @reject {RecipientsNotFoundError}
	 * @reject {TooManyRequestsError}
	 * @reject {AccessBlockedError}
	 * @reject {FileNotFoundError}
	 * @reject {PreconditionFailedError}
	 * @reject {LockedError}
	 * @reject {UserError}
	 */
	send(body: string): Promise<*> {
		return Promise
			.resolve()
			.then(() => {
				if (this._toRecipients.length === 0 && this._ccRecipients.length === 0 && this._bccRecipients.length === 0) {
					throw new UserError("noRecipients_msg")
				}
			})
			.then(() => {
				return this
					._waitForResolvedRecipients() // Resolve all added recipients before trying to send it
					.then((recipients) => {
						if (recipients.length === 1 && recipients[0].mailAddress.toLowerCase().trim() === "approval@tutao.de") {
							return [recipients, true]
						} else {
							return this.saveDraft(body, /*saveAttachments*/true)
							           .return([recipients, false])
						}
					})
					.then(([resolvedRecipients, isApprovalMail]) => {
						if (isApprovalMail) {
							return this._sendApprovalMail(body)
						} else {
							let externalRecipients = resolvedRecipients.filter(r => isExternal(r))
							if (this._confidentialButtonState && externalRecipients.length > 0
								&& externalRecipients.some(r => r.contact && r.contact.presharedPassword) == null) {
								throw new UserError("noPreSharedPassword_msg")
							}

							let sendMailConfirm = Promise.resolve(true)
							if (this._confidentialButtonState
								&& externalRecipients.reduce((min, current) =>
									Math.min(min, this.getPasswordStrength(current)), 100) < 80) {
								sendMailConfirm = Dialog.confirm("presharedPasswordNotStrongEnough_msg")
							}

							return sendMailConfirm.then(ok => {
								if (ok) {
									return this._updateContacts(resolvedRecipients)
										// TODO
										       .then(() => ({calendarFileMethods: []}))
										       .then(({calendarFileMethods}) => worker.sendMailDraft(
											       neverNull(this.draft),
											       resolvedRecipients,
											       // TODO
											       this._selectedNotificationLanguage,
											       calendarFileMethods
										       ))
										       .then(() => this._updatePreviousMail())
										       .then(() => this._updateExternalLanguage())
										       .then(() => this._close())
								}
							})
						}
					})

			})
	}

	_sendApprovalMail(body: string) {
		const listId = "---------c--";
		const m = createApprovalMail({
			_id: [listId, stringToCustomId(this._senderAddress)],
			_ownerGroup: logins.getUserController().user.userGroup.group,
			text: `Subject: ${this._subject()}<br>${body}`,
		})
		return setup(listId, m)
			.catch(NotAuthorizedError, e => console.log("not authorized for approval message"))
	}

	_updateExternalLanguage() {
		let props = logins.getUserController().props
		if (props.notificationMailLanguage !== this._selectedNotificationLanguage) {
			props.notificationMailLanguage = this._selectedNotificationLanguage
			update(props)
		}
	}

	_updatePreviousMail(): Promise<void> {
		if (this._previousMail) {
			if (this._previousMail.replyType === ReplyType.NONE && this._conversationType === ConversationType.REPLY) {
				this._previousMail.replyType = ReplyType.REPLY
			} else if (this._previousMail.replyType === ReplyType.NONE
				&& this._conversationType === ConversationType.FORWARD) {
				this._previousMail.replyType = ReplyType.FORWARD
			} else if (this._previousMail.replyType === ReplyType.FORWARD
				&& this._conversationType === ConversationType.REPLY) {
				this._previousMail.replyType = ReplyType.REPLY_FORWARD
			} else if (this._previousMail.replyType === ReplyType.REPLY
				&& this._conversationType === ConversationType.FORWARD) {
				this._previousMail.replyType = ReplyType.REPLY_FORWARD
			} else {
				return Promise.resolve()
			}
			return update(this._previousMail).catch(NotFoundError, e => {
				// ignore
			})
		} else {
			return Promise.resolve();
		}
	}

	_updateContacts(resolvedRecipients: RecipientInfo[]): Promise<any> {
		return Promise.all(resolvedRecipients.map(r => {
			const {contact} = r
			if (contact) {
				if (!contact._id
					&& (!logins.getUserController().props.noAutomaticContacts || (isExternal(r) && this._confidentialButtonState))
				) {
					if (isExternal(r) && this._confidentialButtonState) {
						contact.presharedPassword = this._getPassword(r).trim()
					}
					return LazyContactListId.getAsync().then(listId => {
						return setup(listId, contact)
					})
				} else if (contact._id
					&& isExternal(r)
					&& this._confidentialButtonState
					&& contact.presharedPassword !== this._getPassword(r).trim()
				) {
					contact.presharedPassword = this._getPassword(r).trim()
					return update(contact)
				} else {
					return Promise.resolve()
				}
			} else {
				return Promise.resolve()
			}
		}))
	}

	_getPassword(r: RecipientInfo): string {
		return r.contact && r.contact.presharedPassword || ""
	}

	_allRecipients(): Array<RecipientInfo> {
		return this._toRecipients
		           .concat(this._ccRecipients)
		           .concat(this._bccRecipients)
	}

	/**
	 * Makes sure the recipient type and contact are resolved.
	 */
	_waitForResolvedRecipients(): Promise<RecipientInfo[]> {
		return Promise.all(this._allRecipients().map(recipientInfo => {
			return resolveRecipientInfo(recipientInfo).then(recipientInfo => {
				if (recipientInfo.resolveContactPromise) {
					return recipientInfo.resolveContactPromise.return(recipientInfo)
				} else {
					return recipientInfo
				}
			})
		})).catch(TooManyRequestsError, () => {
			throw new RecipientNotResolvedError()
		})
	}

	_handleEntityEvent(update: EntityUpdateData): void {
		const {operation, instanceId, instanceListId} = update
		if (isUpdateForTypeRef(ContactTypeRef, update)
			&& (operation === OperationType.UPDATE || operation === OperationType.DELETE)) {
			let contactId: IdTuple = [neverNull(instanceListId), instanceId]

			this._allRecipients().forEach(recipient => {
				if (recipient.contact && recipient.contact._id && isSameId(recipient.contact._id, contactId)) {
					if (operation === OperationType.UPDATE) {
						// TODO
						// this._updateBubble(bubbles, bubble, contactId)
					} else {
						// TODO
						// this._removeBubble(bubble)
					}
				}
			})
		}
	}
}


function getTemplateLanguages(sortedLanguages: Array<Language>): Promise<Array<Language>> {
	return logins.getUserController().loadCustomer()
	             .then((customer) => load(CustomerPropertiesTypeRef, neverNull(customer.properties)))
	             .then((customerProperties) => {
		             return sortedLanguages.filter(sL =>
			             customerProperties.notificationMailTemplates.find((nmt) => nmt.language === sL.code))
	             })
	             .catch(() => [])
}