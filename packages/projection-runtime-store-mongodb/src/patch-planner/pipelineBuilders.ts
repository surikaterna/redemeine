export const buildMiddleArrayRemovePipeline = (
  mongoArrayPath: string,
  removeAtIndex: number
): ReadonlyArray<Record<string, unknown>> => {
  const fieldRef = `$state.${mongoArrayPath}`;

  return [
    {
      $set: {
        [`state.${mongoArrayPath}`]: {
          $concatArrays: [
            {
              $slice: [fieldRef, removeAtIndex]
            },
            {
              $slice: [
                fieldRef,
                removeAtIndex + 1,
                {
                  $subtract: [{ $size: fieldRef }, removeAtIndex + 1]
                }
              ]
            }
          ]
        }
      }
    }
  ];
};

export const buildMiddleArrayInsertPipeline = (
  mongoArrayPath: string,
  insertAtIndex: number,
  insertedValue: unknown
): ReadonlyArray<Record<string, unknown>> => {
  const fieldRef = `$state.${mongoArrayPath}`;

  return [
    {
      $set: {
        [`state.${mongoArrayPath}`]: {
          $concatArrays: [
            {
              $slice: [fieldRef, insertAtIndex]
            },
            [insertedValue],
            {
              $slice: [
                fieldRef,
                insertAtIndex,
                {
                  $subtract: [{ $size: fieldRef }, insertAtIndex]
                }
              ]
            }
          ]
        }
      }
    }
  ];
};
