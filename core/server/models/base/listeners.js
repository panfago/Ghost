var config = require('../../config'),
    events = require(config.get('paths:corePath') + '/server/events'),
    models = require(config.get('paths:corePath') + '/server/models'),
    errors = require(config.get('paths:corePath') + '/server/errors'),
    logging = require(config.get('paths:corePath') + '/server/logging'),
    sequence = require(config.get('paths:corePath') + '/server/utils/sequence'),
    moment = require('moment-timezone');

/**
 * WHEN access token is created we will update last_seen for user.
 */
events.on('token.added', function (tokenModel) {
    models.User.edit({last_seen: moment().toDate()}, {id: tokenModel.get('user_id')})
        .catch(function (err) {
            logging.error(new errors.GhostError({err: err, level: 'critical'}));
        });
});

/**
 * WHEN user get's suspended (status=inactive), we delete his tokens to ensure
 * he can't login anymore
 */
events.on('user.deactivated', function (userModel) {
    var options = {id: userModel.id};

    models.Accesstoken.destroyByUser(options)
        .then(function () {
            return models.Refreshtoken.destroyByUser(options);
        })
        .catch(function (err) {
            logging.error(new errors.GhostError({
                err: err,
                level: 'critical'
            }));
        });
});

/**
 * WHEN timezone changes, we will:
 * - reschedule all scheduled posts
 * - draft scheduled posts, when the published_at would be in the past
 */
events.on('settings.activeTimezone.edited', function (settingModel) {
    var newTimezone = settingModel.attributes.value,
        previousTimezone = settingModel._updatedAttributes.value,
        timezoneOffsetDiff = moment.tz(newTimezone).utcOffset() - moment.tz(previousTimezone).utcOffset();

    // CASE: TZ was updated, but did not change
    if (previousTimezone === newTimezone) {
        return;
    }

    models.Post.findAll({filter: 'status:scheduled', context: {internal: true}})
        .then(function (results) {
            if (!results.length) {
                return;
            }

            return sequence(results.map(function (post) {
                return function reschedulePostIfPossible() {
                    var newPublishedAtMoment = moment(post.get('published_at')).add(timezoneOffsetDiff, 'minutes');

                    /**
                     * CASE:
                     *   - your configured TZ is GMT+01:00
                     *   - now is 10AM +01:00 (9AM UTC)
                     *   - your post should be published 8PM +01:00 (7PM UTC)
                     *   - you reconfigure your blog TZ to GMT+08:00
                     *   - now is 5PM +08:00 (9AM UTC)
                     *   - if we don't change the published_at, 7PM + 8 hours === next day 5AM
                     *   - so we update published_at to 7PM - 480minutes === 11AM UTC
                     *   - 11AM UTC === 7PM +08:00
                     */
                    if (newPublishedAtMoment.isBefore(moment().add(5, 'minutes'))) {
                        post.set('status', 'draft');
                    } else {
                        post.set('published_at', newPublishedAtMoment.toDate());
                    }

                    return models.Post.edit(post.toJSON(), {id: post.id, context: {internal: true}}).reflect();
                };
            })).each(function (result) {
                if (!result.isFulfilled()) {
                    logging.error(new errors.GhostError({
                        err: result.reason()
                    }));
                }
            });
        })
        .catch(function (err) {
            logging.error(new errors.GhostError({
                err: err,
                level: 'critical'
            }));
        });
});
