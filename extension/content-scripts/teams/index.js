let isTeamsInjected = false

setInterval(() => {
  // Meeting lobby. Shown for scheduled meetings and "Meet now" meetings
  const isJoinButtonFound = Boolean(document.querySelector(SELECTORS_TEAMS.PREJOIN_JOIN_BUTTON))
  // Live call UI. Impromptu one to one and group calls connect straight away, without a lobby
  const isHangupButtonFound = Boolean(document.querySelector(SELECTORS_TEAMS.HANGUP_BUTTON))

  // On the meeting lobby or already in a call, and main teams function is not running, inject it
  if ((isJoinButtonFound || isHangupButtonFound) && !isTeamsInjected) {
    initTeams()
    isTeamsInjected = true
  }
  // Reset flag only when neither the lobby nor a call is on screen, so that the lobby to call transition does not trigger a second injection into the same meeting
  if (!isJoinButtonFound && !isHangupButtonFound) {
    isTeamsInjected = false
  }
}, 2000)

function initTeams() {
  // Attempt to recover last meeting, if any. Abort if it takes more than 2 seconds to prevent current meeting getting messed up.
  Promise.race([
    recoverLastMeeting(),
    new Promise((_, reject) =>
      setTimeout(() => reject({ errorCode: "016", errorMessage: "Recovery timed out" }), 2000)
    )
  ]).
    catch((error) => {
      const parsedError = /** @type {ErrorObject} */ (error)
      if ((parsedError.errorCode !== "013") && (parsedError.errorCode !== "014")) {
        console.error(parsedError.errorMessage)
      }
    }).
    finally(() => {
      // Initialise new state for current meeting
      const state = createContentScriptState("Teams", "teams")
      // Push fresh state to chrome storage
      overWriteChromeStorage(state, ["meetingSoftware", "meetingStartTimestamp", "meetingTitle", "transcript", "chatMessages"], false)

      checkExtensionStatus(state).finally(() => {
        console.log("Extension status " + state.extensionStatusJSON.status)

        // Enable extension functions only if status is 200
        if (state.extensionStatusJSON.status === 200) {

          teamsMeetingRoutines(state)
        }
        else {
          // Show downtime message as extension status is 400
          showNotificationTeams(state.extensionStatusJSON)
        }
      })
    })
}

/**
 * @param {ContentScriptState} state
 */
function teamsMeetingRoutines(state) {
  renderFab()

  // CRITICAL DOM DEPENDENCY. Wait until the meeting end icon appears, used to detect meeting start
  waitForElement(SELECTORS_TEAMS.HANGUP_BUTTON).then(() => {
    console.log("Meeting started")
    /** @type {ExtensionMessage} */
    const message = {
      type: "new_meeting_started"
    }
    chrome.runtime.sendMessage(message, function () { })
    state.hasMeetingStarted = true
    // Update meeting startTimestamp
    state.meetingStartTimestamp = new Date().toISOString()
    overWriteChromeStorage(state, ["meetingStartTimestamp"], false)

    //*********** MEETING START ROUTINES **********//
    updateMeetingTitle(state)

    // Fire captions shortcut based on operation mode. Async operation.
    chrome.storage.sync.get(["operationMode"], function (resultSyncUntyped) {
      const resultSync = /** @type {ResultSync} */ (resultSyncUntyped)
      if (resultSync.operationMode === "manual") {
        console.log("Manual mode selected, leaving transcript off")
        showNotificationTeams({ status: 400, message: "<strong>TranscripTonic is not running</strong> <br /> Turn on captions, if needed (More > Language > Captions)" })
      }
      else {
        // Allow keyboard event listener to be ready
        setTimeout(() => {
          dispatchLiveCaptionsShortcut()
          // Show message to enable because keyboard shortcut does not work in guest meetings
          showNotificationTeams(state.extensionStatusJSON)
        }, 2000)
      }
    })

    // **** REGISTER TRANSCRIPT LISTENER **** //
    // Wait for transcript node to be visible
    waitForElement(SELECTORS_TEAMS.CAPTIONS_REGION).then((element) => {
      console.log("Found captions container")
      // CRITICAL DOM DEPENDENCY. Grab the transcript element.
      state.transcriptTargetNode = element

      if (state.transcriptTargetNode) {
        // Create transcript observer instance linked to the callback function. Registered irrespective of operation mode, so that any visible transcript can be picked up during the meeting, independent of the operation mode.
        // Initial attach and monitor every 2s
        startTranscriptMonitor(state)
      }
      else {
        throw new Error("Transcript element not found in DOM")
      }
    })
      .catch((err) => {
        console.error(err)
        state.isTranscriptDomErrorCaptured = true
        showNotificationTeams(extensionStatusJSON_bug)

        logError(state, "001", err)
      })


    //*********** MEETING END ROUTINES **********//
    waitForElement(SELECTORS_TEAMS.HANGUP_BUTTON).then((element) => {
      // For some reason, capturing the reference to #hangup-button immediately is not working. Need to wait for a moment.
      setTimeout(() => {
        // CRITICAL DOM DEPENDENCY. Event listener to capture meeting end button click by user
        let endCallElement = element
        if (endCallElement?.nextElementSibling?.tagName === "BUTTON") {
          endCallElement = /** @type {Element} */ (endCallElement?.parentElement)
        }
        endCallElement?.addEventListener("click", meetingEndRoutines)

        // In impromptu calls, the other person can end the call, so the local user never clicks hangup. Poll for the call UI disappearing as a fallback.
        const callUiMonitor = setInterval(() => {
          if (state.hasMeetingEnded) {
            clearInterval(callUiMonitor)
            return
          }
          if (!document.querySelector(SELECTORS_TEAMS.HANGUP_BUTTON)) {
            clearInterval(callUiMonitor)
            meetingEndRoutines()
          }
        }, 2000)

        function meetingEndRoutines() {
          // Guard against the click listener and the call UI monitor both firing
          if (state.hasMeetingEnded) {
            return
          }
          endCallElement?.removeEventListener("click", meetingEndRoutines)
          console.log("Meeting ended")
          // To suppress further errors
          state.hasMeetingEnded = true
          if (state.transcriptObserver) {
            state.transcriptObserver.disconnect()
          }

          // Push any data in the buffer variables to the transcript array. Needed to handle one or more speaking when meeting ends.
          pushBufferToTranscript(state)
          // Save to chrome storage and send message to download transcript from background script
          overWriteChromeStorage(state, ["transcript", "chatMessages"], true)

          unmountFab()
        }
      }, 1000)
    })
  })
}




/**
   * @description Callback function to execute when transcription mutations are observed.
   * @param {ContentScriptState} state
   * @param {MutationRecord[]} mutationsList
   */
function transcriptMutationCallbackTeams(state, mutationsList) {
  mutationsList.forEach(async (mutation) => {
    try {
      // const transcriptTargetNode = document.querySelector(`[data-tid="closed-caption-v2-virtual-list-content"]`)
      if (mutation.type === "characterData") {
        const mutationTargetElement = mutation.target.parentElement

        const currentPersonName = mutationTargetElement?.parentElement?.previousSibling?.textContent
        const currentTranscriptText = mutationTargetElement?.textContent

        if (currentPersonName && currentTranscriptText) {
          // Starting fresh in a meeting
          if (!state.stateTranscriptBlock.mutationTargetElement) {
            state.stateTranscriptBlock.mutationTargetElement = mutation.target.parentElement
            state.stateTranscriptBlock.personName = currentPersonName
            state.stateTranscriptBlock.timestamp = new Date().toISOString()
            state.stateTranscriptBlock.transcriptTextBuffer = currentTranscriptText
          }
          // Some prior transcript buffer exists
          else {
            // New transcript UI block
            if (state.stateTranscriptBlock.mutationTargetElement !== mutation.target.parentElement) {
              // Push previous transcript block
              pushBufferToTranscript(state)

              // Update stateTranscriptBlock for next mutation and store transcript block timestamp
              state.stateTranscriptBlock.mutationTargetElement = mutation.target.parentElement
              state.stateTranscriptBlock.personName = currentPersonName
              state.stateTranscriptBlock.timestamp = new Date().toISOString()
              state.stateTranscriptBlock.transcriptTextBuffer = currentTranscriptText
            }
            // Same transcript UI block being appended
            else {
              // Update stateTranscriptBlock for next mutation
              state.stateTranscriptBlock.transcriptTextBuffer = currentTranscriptText
            }
          }
        }

        // Rendered by the side panel
        broadcastLiveBuffer(state)
      }
    }
    catch (err) {
      console.error(err)
      if (!state.isTranscriptDomErrorCaptured && !state.hasMeetingEnded) {
        console.log(reportErrorMessage)
        showNotificationTeams(extensionStatusJSON_bug)

        logError(state, "005", err)
      }
      state.isTranscriptDomErrorCaptured = true
    }
  })
}