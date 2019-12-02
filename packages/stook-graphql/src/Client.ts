import { useState, useEffect } from 'react'
import { useStore } from 'stook'
import gql from 'graphql-tag'
import compose from 'koa-compose'
import { GraphQLClient } from '@peajs/graphql-client'
import { SubscriptionClient } from 'subscriptions-transport-ws'

import { fetcher } from './fetcher'
import {
  Options,
  QueryResult,
  Deps,
  Refetch,
  FetcherItem,
  Middleware,
  Ctx,
  GraphqlOptions,
  Mutate,
  MutateResult,
  Variables,
  SubscribeResult,
  SubscriptionOption,
  FromSubscriptionOption,
  Observer,
} from './types'

function getDeps(options?: Options): Deps {
  if (options && Array.isArray(options.deps)) return options.deps
  return []
}

const NULL_AS: any = null

export class Client {
  graphqlOptions: GraphqlOptions
  middleware: Middleware[] = []

  graphqlClient: GraphQLClient = NULL_AS
  subscriptionClient: SubscriptionClient = NULL_AS

  ctx: Ctx = {
    body: undefined,
    headers: {},
    valid: true,
  }

  constructor(opt: GraphqlOptions = { endpoint: '/graphql', headers: {} }) {
    const { endpoint, headers, subscriptionsEndpoint } = opt
    this.graphqlOptions = opt
    this.graphqlClient = new GraphQLClient({
      endpoint,
      headers,
    } as any)

    if (subscriptionsEndpoint) {
      this.subscriptionClient = new SubscriptionClient(subscriptionsEndpoint, {
        reconnect: true,
      })
    }
  }

  config = (opt: GraphqlOptions = { endpoint: '/graphql', headers: {} }) => {
    this.graphqlOptions = { ...this.graphqlOptions, ...opt }

    const { endpoint, headers, subscriptionsEndpoint } = opt
    this.graphqlClient = new GraphQLClient({
      endpoint,
      headers,
    } as any)

    if (subscriptionsEndpoint) {
      this.subscriptionClient = new SubscriptionClient(subscriptionsEndpoint, {
        reconnect: true,
      })
    }
  }

  applyMiddleware = (fn: Middleware) => {
    this.middleware.push(fn)
  }

  query = async <T = any>(input: string, options: Options = {}) => {
    const { variables = {} } = options
    const action = async (ctx: Ctx) => {
      try {
        ctx.body = await this.graphqlClient.query<T>(input, variables, {
          headers: options.headers || ({} as any),
        })
      } catch (error) {
        ctx.body = error
        ctx.valid = false
      }
    }

    await compose([...this.middleware, action])(this.ctx)

    if (!this.ctx.valid) throw this.ctx.body
    return this.ctx.body
  }

  useQuery<T = any>(input: string, options: Options<T> = {}) {
    const { initialData: data, onUpdate } = options
    const fetcherName = options.key || input
    let unmounted = false
    const initialState = { loading: true, data } as QueryResult<T>
    const deps = getDeps(options)
    const [result, setState] = useStore(fetcherName, initialState)

    function update(nextState: QueryResult<T>) {
      setState(nextState)
      onUpdate && onUpdate(nextState)
    }

    const doFetch = async (opt: Options = {}) => {
      if (unmounted) return

      try {
        const data = await this.query<T>(input, opt || {})
        update({ loading: false, data } as QueryResult<T>)
        return data
      } catch (error) {
        update({ loading: false, error } as QueryResult<T>)
        return error
      }
    }

    const refetch: Refetch = async <P = any>(opt?: Options): Promise<P> => {
      const data: any = await doFetch(opt)
      return data as P
    }

    useEffect(() => {
      doFetch(options)

      // store refetch fn to fetcher
      fetcher.set(fetcherName, { refetch } as FetcherItem<T>)

      return () => {
        unmounted = true
      }
    }, deps)

    return { ...result, refetch }
  }

  useMutate = <T = any>(input: string, options: Options = {}) => {
    const { initialData: data, onUpdate } = options
    const initialState = { loading: false, data } as MutateResult<T>
    const fetcherName = options.key || input
    const [result, setState] = useStore(fetcherName, initialState)

    function update(nextState: MutateResult<T>) {
      setState(nextState)
      onUpdate && onUpdate(nextState)
    }

    const doFetch = async (opt: Options = {}) => {
      try {
        const data = await this.query<T>(input, { ...options, ...opt })
        update({ loading: false, data } as MutateResult<T>)
        return data
      } catch (error) {
        update({ loading: false, error } as MutateResult<T>)
        return error
      }
    }

    const mutate = (variables: Variables, opt: Options = {}): any => {
      update({ loading: true } as MutateResult<T>)
      doFetch({ ...opt, variables })
    }

    const out: [Mutate, MutateResult<T>] = [mutate, result]

    return out
  }

  useSubscribe = <T = any>(input: string, options: SubscriptionOption<T> = {}) => {
    const { variables = {}, operationName = '', initialQuery = '', onUpdate } = options

    let unmounted = false
    const initialState = { loading: true } as SubscribeResult<T>
    const [result, setState] = useState(initialState)

    function update(nextState: SubscribeResult<T>) {
      setState(nextState)
      onUpdate && onUpdate(nextState)
    }

    const initQuery = async () => {
      if (!initialQuery) return
      if (unmounted) return

      try {
        let data = await this.query<T>(initialQuery.query, {
          variables: initialQuery.variables || {},
        })
        update({ loading: false, data } as SubscribeResult<T>)
        return data
      } catch (error) {
        update({ loading: false, error } as SubscribeResult<T>)
        return error
      }
    }

    const initSubscribe = async () => {
      if (unmounted) return

      this.subscriptionClient
        .request({
          query: gql`
            ${input}
          `,
          variables,
          operationName,
        })
        .subscribe({
          next: ({ data }) => {
            const action = async (ctx: Ctx) => {
              ctx.body = data
            }
            compose([...this.middleware, action])(this.ctx).then(() => {
              update({ loading: false, data: this.ctx.body } as SubscribeResult<T>)
            })
          },
          error: error => {
            const action = async (ctx: Ctx) => {
              ctx.body = error
              ctx.valid = false
            }

            compose([...this.middleware, action])(this.ctx).then(() => {
              update({ loading: false, error: this.ctx.body } as SubscribeResult<T>)
            })
          },
          complete() {
            console.log('completed')
          },
        })
    }

    useEffect(() => {
      if (initialQuery) initQuery()
      initSubscribe()
      return () => {
        unmounted = true
      }
    }, [])

    return result
  }

  fromSubscription = <T = any>(input: string, options: FromSubscriptionOption = {}) => {
    const { variables = {} } = options

    if (!this.subscriptionClient) {
      throw new Error('require subscriptionsEndpoint config')
    }

    return {
      subscribe: (observer: Observer<T>) => {
        const ob = {} as Observer<T>

        if (observer.next) {
          ob.next = (data: T) => {
            if (observer.next) observer.next(data)
          }
        }

        if (observer.error) ob.error = observer.error
        if (observer.error) ob.complete = observer.complete

        return this.subscriptionClient
          .request({
            query: gql`
              ${input}
            `,
            variables,
          })
          .subscribe(ob as any) // TODO:
      },
    }
  }
}